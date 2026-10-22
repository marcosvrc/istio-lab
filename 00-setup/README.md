# 00 — Instalação e fundamentos

**Objetivo:** subir o Istio no Rancher Desktop, entender o que foi instalado, ver o sidecar em ação e dominar os comandos de diagnóstico que serão usados em todos os módulos seguintes.

## O que é instalado

| Namespace | Componente | Para que serve |
|---|---|---|
| `istio-system` | `istiod` | Control plane: distribui config para os Envoys (xDS) e emite certificados (CA do mTLS) |
| `istio-system` | `istio-ingressgateway` | Envoy de borda, exposto via LoadBalancer em `localhost` |
| `istio-system` | Prometheus, Grafana, Jaeger, Kiali | Observabilidade |
| `bookinfo` | productpage, details, reviews v1/v2/v3, ratings | App de exemplo com várias versões (base dos exercícios de tráfego) |
| `sandbox` | `httpbin`, `curl` | Servidor e cliente genéricos para testes |

Arquivos:

- `istio-operator.yaml` — config do control plane (perfil `default`, access log, provider de tracing, requests reduzidos)
- `manifests/telemetry.yaml` — liga tracing com 100% de amostragem
- `manifests/destination-rules.yaml` — subsets por versão (v1/v2/v3) dos serviços do Bookinfo
- `manifests/bookinfo-gateway.yaml` — `Gateway` + `VirtualService` expondo o Bookinfo
- `install.sh` / `uninstall.sh` / `traffic.sh`

## Pré-requisitos

1. Rancher Desktop com Kubernetes ligado e **Traefik desabilitado** (Preferences → Kubernetes). O script aborta se encontrar o Traefik.
2. `istioctl` no PATH. O script usa a versão do cliente para baixar os samples da mesma release.
3. O contexto `rancher-desktop` é usado por padrão. Para outro cluster: `KUBE_CONTEXT=meu-ctx ./install.sh`.

## Instalação

```bash
./install.sh
```

Teste:

```bash
curl -s http://localhost/productpage | grep -o '<title>.*</title>'
# <title>Simple Bookstore App</title>
```

Abra http://localhost/productpage no navegador e recarregue algumas vezes. As estrelas mudam (nenhuma / pretas / vermelhas) porque o Service `reviews` faz round-robin entre v1, v2 e v3. Controlar isso é o assunto do módulo 01.

---

## Exercícios

### 1. Perfis de instalação

```bash
istioctl profile list
istioctl profile diff default demo
istioctl manifest generate -f istio-operator.yaml | less   # tudo o que o install aplica
```

> Por que o perfil `demo` não é recomendado em produção? Olhe sampling, recursos e egress gateway no diff.

### 2. Injeção do sidecar

```bash
kubectl get ns -L istio-injection
kubectl -n bookinfo get pods          # repare no READY 2/2
kubectl -n bookinfo get pod -l app=productpage -o jsonpath='{.items[0].spec.containers[*].name}{"\n"}{.items[0].spec.initContainers[*].name}{"\n"}'
```

- `istio-init` (init container) instala as regras de iptables que redirecionam o tráfego do pod para o Envoy.
- `istio-proxy` é o Envoy.

Faça um pod **sem** sidecar e compare:

```bash
kubectl create ns nomesh
kubectl -n nomesh run curl --image=curlimages/curl --command -- sleep infinity
kubectl -n nomesh get pod curl          # READY 1/1
kubectl -n nomesh exec curl -- curl -s http://productpage.bookinfo:9080/productpage | head -5
```

> Funciona porque o mTLS está em modo PERMISSIVE por padrão. No módulo 02 isso vai quebrar com STRICT.

Injeção manual (útil para ver o que o webhook muda no YAML):

```bash
kubectl -n sandbox get deploy httpbin -o yaml | istioctl kube-inject -f - | less
```

### 3. Comandos de diagnóstico (decore estes)

```bash
istioctl proxy-status                                   # todos os Envoys conectados ao istiod (CDS, LDS, EDS, RDS)?
istioctl analyze -A                                     # erros/avisos de config

POD=$(kubectl -n bookinfo get pod -l app=productpage -o jsonpath='{.items[0].metadata.name}')
istioctl proxy-config listeners $POD -n bookinfo        # em que portas o Envoy escuta
istioctl proxy-config routes    $POD -n bookinfo        # tabela de rotas HTTP
istioctl proxy-config clusters  $POD -n bookinfo        # upstreams conhecidos (um por service/porta/subset)
istioctl proxy-config endpoints $POD -n bookinfo --cluster "outbound|9080||reviews.bookinfo.svc.cluster.local"
istioctl proxy-config secret    $POD -n bookinfo        # certificado SPIFFE do workload

istioctl x describe pod $POD -n bookinfo                # resumo do que se aplica a este pod
```

> Exercício: encontre os subsets `v1`, `v2` e `v3` de `reviews` na saída de `clusters`. Eles vêm de `manifests/destination-rules.yaml`.

### 4. Access logs

```bash
kubectl -n bookinfo logs deploy/productpage -c istio-proxy --tail=5
kubectl -n istio-system logs deploy/istio-ingressgateway --tail=5
```

Identifique na linha de log: código de resposta, `response_flags` (ex.: `UH`, `UF`, `NR`), upstream escolhido e duração.

Mudar o nível de log do Envoy em tempo real:

```bash
istioctl proxy-config log $POD -n bookinfo --level debug
istioctl proxy-config log $POD -n bookinfo --level warning
```

### 5. Observabilidade

Em um terminal, deixe gerando tráfego:

```bash
./traffic.sh
```

Em outro, abra os dashboards:

```bash
istioctl dashboard kiali      # Graph → namespace bookinfo → ligue "Traffic Animation" e "Security"
istioctl dashboard grafana    # Dashboards → Istio → Istio Service Dashboard
istioctl dashboard jaeger     # Service: productpage.bookinfo → Find Traces
istioctl dashboard prometheus # query: sum(rate(istio_requests_total{destination_service_namespace="bookinfo"}[1m])) by (destination_workload)
```

> No Kiali, confirme que o tráfego entre os serviços tem o cadeado (mTLS automático, mesmo em PERMISSIVE).

### 6. Gateway API (prévia)

O Istio também implementa a Kubernetes Gateway API, que é o caminho recomendado daqui para frente. Instale os CRDs para usá-los no módulo 01:

```bash
kubectl get crd gateways.gateway.networking.k8s.io >/dev/null 2>&1 || \
  kubectl apply -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.3.0/standard-install.yaml
```

---

## Checklist de conclusão

- [ ] `istioctl proxy-status` lista todos os proxies inscritos em `CDS,LDS,EDS,RDS`
- [ ] Bookinfo responde em http://localhost/productpage
- [ ] Sei explicar o papel de `istiod`, `istio-init` e `istio-proxy`
- [ ] Sei usar `proxy-config` para ver listeners, routes, clusters e endpoints
- [ ] Vi o grafo no Kiali, métricas no Grafana e um trace no Jaeger

## Limpeza

```bash
kubectl delete ns nomesh --ignore-not-found
./uninstall.sh     # só quando quiser remover tudo; os próximos módulos dependem desta base
```
