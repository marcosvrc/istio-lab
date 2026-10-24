# 03 — Observabilidade

**Objetivo:** usar a telemetria que o Istio gera "de graça" (métricas, logs e traces de todo o tráfego) para entender, medir e diagnosticar a mesh, e customizá-la com a Telemetry API.

| # | Exercício | Ferramentas / recursos |
|---|---|---|
| 1 | Diagnosticar uma configuração quebrada | Kiali, `istioctl analyze`, access log |
| 2 | Métricas de ouro com PromQL (tráfego, erros, latência) | Prometheus, `istio_requests_total`, histogramas |
| 3 | Customizar e desligar métricas | `Telemetry.metrics` |
| 4 | Access logs filtrados e em JSON | `Telemetry.accessLogging` |
| 5 | Tracing com OpenTelemetry, tags e amostragem | `Telemetry.tracing`, Jaeger |
| 6 | Dashboards | Grafana |

## Conceitos-chave

- **Métricas** são geradas por cada Envoy, nos dois lados da chamada: `reporter="source"` (cliente) e `reporter="destination"` (servidor). As duas visões podem divergir, e isso é informação (veja o exercício 2).
- **Access logs** são uma linha por requisição, em cada proxy. O campo mais útil são os *response flags* (`UH`, `UF`, `NR`, `NC`, `UT`, `FI`, `DI`...).
- **Traces**: o Envoy cria os spans, mas **a aplicação precisa propagar os headers** de contexto (`traceparent`, `x-b3-*`, `x-request-id`) da requisição recebida para as que faz. Sem isso, cada salto vira um trace separado. O Bookinfo já propaga.
- **Telemetry API** configura os três sinais em camadas: mesh (`istio-system`) → namespace → workload (`selector`). O mais específico vence.
- **Providers** (destinos de traces/logs) ficam em `meshConfig.extensionProviders`. Este lab define `jaeger` (Zipkin), `otel-tracing` (OTLP), `json-access-log` e `envoy` (built-in) em `../00-setup/istio-operator.yaml`.

## Preparação

Requer o módulo 00. Rode o `reset.sh` dos módulos 01 e 02 se os fez. É preciso `jq`.

```bash
source ./helpers.sh    # promql, traces, trace_tags, traces_with, mcurl, load
```

Para os dashboards, deixe tráfego rodando em outro terminal: `../00-setup/traffic.sh`.

Para voltar ao estado inicial: `./reset.sh`.

---

## 1. Diagnosticar uma configuração quebrada

```bash
kubectl apply -f manifests/01-broken-config.yaml
curl -s localhost/productpage | grep -o 'Sorry, product reviews[^<.]*'
```

A página carrega, mas sem reviews. Investigue como faria em produção, do mais rápido ao mais detalhado:

```bash
# 1. Validação estática
istioctl analyze -n bookinfo
#    IST0101: Referenced host+subset in destinationrule not found: "reviews+v4"

# 2. Access log do CLIENTE (o productpage): quem gerou o erro?
kubectl -n bookinfo logs deploy/productpage-v1 -c istio-proxy --tail=20 | grep reviews
#    "GET /reviews/0" 503 NC cluster_not_found   ← o próprio Envoy respondeu; não chegou a nenhum pod

# 3. A config do Envoy confirma: a rota aponta para um cluster que não existe
istioctl pc routes deploy/productpage-v1 -n bookinfo --name 9080 -o json | grep -m1 'subset\|v4'
istioctl pc clusters deploy/productpage-v1 -n bookinfo | grep reviews
```

No **Kiali** (`istioctl dashboard kiali`): *Istio Config* mostra o VirtualService com erro, e o *Graph* mostra a aresta productpage → reviews em vermelho.

| Flag | Significado | Causa típica |
|---|---|---|
| `NC` | no cluster | subset/host inexistente na DestinationRule |
| `NR` | no route | nenhuma rota casou (VS/Gateway) |
| `UH` | no healthy upstream | zero pods prontos, ou todos ejetados pelo outlier detection |
| `UF` / `URX` | upstream connection failure / retries esgotados | pod caindo, mTLS incompatível |
| `UT` | upstream timeout | `timeout` do VirtualService |
| `UO` | upstream overflow | circuit breaker |
| `FI` / `DI` | fault injection abort / delay | `fault` do VirtualService |

```bash
kubectl delete -f manifests/01-broken-config.yaml
```

## 2. Métricas de ouro com PromQL

Injete erros (30%) e lentidão (50% com +500ms) no ratings e gere tráfego:

```bash
kubectl apply -f manifests/02-ratings-errors.yaml
load 150
```

**Tráfego** (requisições/s por workload):

```bash
promql 'sum(rate(istio_requests_total{reporter="destination",destination_service_namespace="bookinfo"}[1m])) by (destination_workload)'
```

**Erros**: compare o que o cliente e o servidor veem:

```bash
promql 'sum(increase(istio_requests_total{reporter="source",destination_service_name="ratings"}[1m])) by (response_code, response_flags, destination_workload)'
#   ... response_code=500 response_flags=FI destination_workload=unknown
promql 'sum(increase(istio_requests_total{reporter="destination",destination_service_name="ratings"}[1m])) by (response_code)'
#   só 200!
```

> O abort acontece **no Envoy do cliente**: a requisição nunca chega ao ratings, por isso o `destination_workload` é `unknown` e o servidor não vê nenhum erro. Em produção vale o mesmo para circuit breaker (`UO`) e falhas de conexão (`UF`). Para medir a experiência do cliente, use `reporter="source"`.

**Taxa de sucesso** (o SLI clássico):

```bash
promql 'sum(rate(istio_requests_total{reporter="source",destination_service_name="ratings",response_code!~"5.."}[1m]))
      / sum(rate(istio_requests_total{reporter="source",destination_service_name="ratings"}[1m]))'
#   ~0.7
```

**Latência** (p50 / p90 / p99 a partir do histograma):

```bash
for q in 0.5 0.9 0.99; do
  promql "histogram_quantile($q, sum(rate(istio_request_duration_milliseconds_bucket{reporter=\"source\",destination_service_name=\"ratings\"}[1m])) by (le))"
done
```

> O p99 dá ~495ms, e não 500+. O `histogram_quantile` interpola dentro do bucket `250–500ms`, e os buckets padrão são largos (0.5, 1, 5, 10, 25, 50, 100, 250, 500, 1000...). Percentil de histograma é estimativa; para SLOs, prefira "% de requisições abaixo de X ms", usando o bucket `le="X"` diretamente. Atenção ao formato: neste Prometheus o label é float (`le="100.0"`, e não `le="100"`), e um filtro com o valor errado devolve vazio sem erro.

**Control plane:**

```bash
promql 'sum(pilot_xds_pushes) by (type)'                                                 # pushes de config por tipo (CDS, EDS, LDS, RDS)
promql 'histogram_quantile(0.99, sum(rate(pilot_proxy_convergence_time_bucket[5m])) by (le))'  # tempo até a config chegar aos proxies (s)
promql 'sum(pilot_xds{version="1.31.0"})'                                                # proxies conectados
```

```bash
kubectl delete -f manifests/02-ratings-errors.yaml
```

## 3. Customizar e desligar métricas

### 3a. Adicionar e remover labels

```bash
kubectl apply -f manifests/03a-metrics-custom-tags.yaml
sleep 10
for i in $(seq 5); do
  mcurl -o /dev/null -H 'x-user: alice' http://reviews.bookinfo:9080/reviews/0
  mcurl -o /dev/null http://reviews.bookinfo:9080/reviews/0
done
sleep 20
promql 'sum(istio_requests_total{reporter="destination",destination_service_name="reviews",source_workload="curl",x_user!=""}) by (x_user, request_method, request_protocol)'
#   request_method=GET x_user=alice
#   request_method=GET x_user=unknown      ← request_protocol sumiu
```

Os valores são expressões CEL sobre os [atributos do Envoy](https://istio.io/latest/docs/reference/config/telemetry/#attributes): `request.method`, `request.headers['...']`, `request.url_path`, `source.workload.name`...

> **Cardinalidade** é o maior custo de métricas. Um label com o `user-id` ou o path completo cria uma série por valor, e o Prometheus cai. Use apenas labels com poucos valores possíveis.

### 3b. Desligar métricas de um namespace

```bash
promql 'sum(istio_requests_total{reporter="destination",destination_workload="httpbin"})'   # anote o valor
kubectl apply -f manifests/03b-metrics-disable.yaml
sleep 10; for i in $(seq 10); do mcurl -o /dev/null http://httpbin:8000/get; done; sleep 20
promql 'sum(istio_requests_total{reporter="destination",destination_workload="httpbin"})'   # não mudou
```

```bash
kubectl delete -f manifests/03a-metrics-custom-tags.yaml -f manifests/03b-metrics-disable.yaml
```

## 4. Access logs

### 4a. Só erros

O lab liga o access log na mesh inteira (`meshConfig.accessLogFile`). Em produção isso é muito volume. Aqui o filtro registra só o que importa no namespace sandbox:

```bash
kubectl apply -f manifests/04a-access-log-errors-only.yaml
sleep 20   # mudança de access log altera o listener do Envoy: demora mais para aplicar
for p in get status/500 headers status/404 get; do mcurl -o /dev/null http://httpbin:8000/$p; done
kubectl -n sandbox logs deploy/httpbin -c istio-proxy --since=10s     # só o 500 e o 404
```

### 4b. JSON para um workload

```bash
kubectl apply -f manifests/04b-access-log-json.yaml
sleep 20; load 2
kubectl -n bookinfo logs deploy/productpage-v1 -c istio-proxy --since=10s | grep '^{' | tail -1 | jq .
```

O formato vem do provider `json-access-log`. Os campos `trace_id` e `source_principal` ligam o log ao trace e à identidade mTLS.

> **Pegadinha:** só pode existir **uma Telemetry sem `selector` por namespace**. Se houver duas, o Istio usa a mais antiga e ignora a outra em silêncio. Para combinar logs, métricas e tracing no mesmo namespace, coloque tudo em um único recurso.

```bash
kubectl delete -f manifests/04a-access-log-errors-only.yaml -f manifests/04b-access-log-json.yaml
```

## 5. Tracing

Veja um trace do Bookinfo (ou abra `istioctl dashboard jaeger`):

```bash
load 5; sleep 5
traces productpage.bookinfo 5
#   spans=9  ingressgateway, productpage, details, reviews, ratings   (reviews v2/v3)
#   spans=7  sem o ratings                                            (reviews v1 não chama o ratings)
```

### 5a. OpenTelemetry e tags customizadas

Troca o provider da mesh de Zipkin para OTLP (o padrão atual) e adiciona tags a todos os spans:

```bash
kubectl apply -f manifests/05a-tracing-otel.yaml
sleep 15
for i in 1 2 3; do curl -s -o /dev/null -H 'x-user: alice' localhost/productpage; done; sleep 5
traces productpage.bookinfo 3
trace_tags productpage.bookinfo | grep -E 'environment|user=|otel.scope'
#   environment=istio-lab   user=alice   otel.scope.name=envoy
```

> Nos primeiros segundos após a troca, alguns traces aparecem incompletos: parte dos proxies ainda envia por Zipkin.

Em produção o destino seria um **OpenTelemetry Collector**, que faz batching, amostragem por cauda (tail sampling) e envia para Tempo, Jaeger ou um vendor. Aqui o Envoy fala OTLP direto com o Jaeger.

### 5b. Amostragem por namespace

```bash
kubectl apply -f manifests/05b-tracing-sampling.yaml
sleep 15; for i in $(seq 10); do mcurl -o /dev/null http://httpbin:8000/anything/sem-trace; done; sleep 5
traces_with httpbin.sandbox sem-trace     # 0
load 5; sleep 5; traces productpage.bookinfo 2   # o bookinfo continua a 100%
```

> A decisão de amostragem é tomada pelo **primeiro** proxy da cadeia e propagada nos headers. Se o ingress amostra 1%, os serviços internos seguem essa decisão.

```bash
./reset.sh   # restaura a Telemetry da mesh (Zipkin, 100%)
```

## 6. Dashboards no Grafana

```bash
../00-setup/traffic.sh &        # tráfego contínuo
istioctl dashboard grafana
```

Dashboards na pasta *Istio*:

| Dashboard | Use para |
|---|---|
| Istio Mesh | Visão geral: RPS, sucesso e latência de todos os serviços |
| Istio Service | Um serviço: quem chama, com que taxa de erro e latência (visão do servidor) |
| Istio Workload | Um deployment: tráfego de entrada **e** de saída |
| Istio Control Plane | Saúde do istiod: pushes, convergência, conflitos, proxies conectados |
| Istio Performance | CPU/memória dos proxies e do istiod |

Exercício: com o tráfego rodando, reaplique `manifests/02-ratings-errors.yaml` e encontre o efeito nos dashboards *Service* (ratings) e *Workload* (reviews-v2). Abra uma das queries no *Explore* e compare com as do exercício 2.

---

## Checklist de conclusão

- [ ] Diagnostiquei um erro com `istioctl analyze`, access log (response flags) e `proxy-config`
- [ ] Sei a diferença entre `reporter="source"` e `reporter="destination"` e quando cada um mente
- [ ] Escrevi queries de taxa de sucesso e p99
- [ ] Adicionei e removi labels de métricas, e entendo o risco de cardinalidade
- [ ] Filtrei access logs com CEL e gerei logs em JSON
- [ ] Troquei o tracing para OpenTelemetry e ajustei a amostragem por namespace
- [ ] Sei que a aplicação precisa propagar os headers de trace

## Limpeza

```bash
./reset.sh
kill %1 2>/dev/null   # traffic.sh, se estiver em background
```
