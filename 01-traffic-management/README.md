# 01 — Gerenciamento de tráfego

**Objetivo:** controlar para onde e como o tráfego flui na mesh, sem mudar uma linha do código das aplicações. É o conjunto de features mais usado do Istio.

| # | Exercício | Recursos |
|---|---|---|
| 1 | Roteamento por versão | `VirtualService`, subsets da `DestinationRule` |
| 2 | Roteamento por usuário (header) | `match.headers` |
| 3 | Canary por peso | `weight` |
| 4 | Ingress: redirect, rewrite, headers, CORS | `Gateway`, `VirtualService` |
| 5 | O mesmo com a Kubernetes Gateway API | `Gateway`, `HTTPRoute` |
| 6 | Injeção de falhas (delay e abort) | `fault` |
| 7 | Timeouts e retries | `timeout`, `retries` |
| 8 | Circuit breaking | `connectionPool`, `outlierDetection` |
| 9 | Load balancing e sticky session | `loadBalancer.consistentHash` |
| 10 | Traffic mirroring | `mirror` |
| 11 | Controle de saída e escopo do sidecar | `Sidecar`, `ServiceEntry` |
| 12 | Egress gateway | `Gateway`, `VirtualService` com `mesh` |

## Conceitos-chave

- **VirtualService** = *como* rotear (regras avaliadas em ordem; a primeira que casa vence).
- **DestinationRule** = *o que fazer depois* de escolhido o destino: subsets, load balancing, connection pool, outlier detection, TLS.
- **Gateway** = configura um Envoy de borda (ingress/egress). Um VirtualService se associa a ele via `gateways:`. Sem `gateways:`, o VS vale para os sidecars (gateway implícito `mesh`).
- A config não muda a aplicação: é o Envoy do **cliente** que aplica rotas, retries, timeouts e circuit breaking.

## Preparação

Requer o módulo 00 instalado.

```bash
./setup.sh   # CRDs da Gateway API, fortio (gerador de carga) e httpbin-v2
```

Atalhos usados nos exercícios (cole no terminal):

```bash
# versão do reviews que respondeu (o productpage mostra o nome do pod)
ver() { curl -s ${1:+-b $1} http://localhost/productpage | grep -oE 'reviews-v[0-9]' | head -1; }
# distribuição em N requisições
dist() { for i in $(seq ${2:-20}); do ver "$1"; done | sort | uniq -c; }
# executa curl de dentro da mesh (pod curl, namespace sandbox)
mcurl() { kubectl -n sandbox exec deploy/curl -c curl -- curl -s "$@"; }
```

> Mudanças de config levam alguns segundos para chegar aos Envoys. Se o resultado parecer errado, espere ~5s e repita.

Para voltar ao estado inicial a qualquer momento: `./reset.sh`.

---

## 1. Roteamento por versão

Sem regra, o Service `reviews` faz balanceamento entre v1, v2 e v3:

```bash
dist          # ~1/3 para cada versão
kubectl apply -f manifests/01-reviews-v1.yaml
dist          # 20 reviews-v1
```

> Veja a rota no Envoy do productpage: `istioctl pc routes deploy/productpage-v1 -n bookinfo --name 9080 -o json | grep -A5 reviews`

## 2. Roteamento por usuário

```bash
kubectl apply -f manifests/02-reviews-jason.yaml
curl -s -c /tmp/jason -o /dev/null -d 'username=jason&passwd=x' http://localhost/login
dist /tmp/jason   # 20 reviews-v2 (estrelas pretas)
dist              # 20 reviews-v1 (anônimo)
```

O productpage propaga o header `end-user` para o reviews. Qualquer header pode ser usado: `x-canary: true`, `user-agent` com regex, etc. Também dá para casar por `uri`, `method`, `queryParams` e `sourceLabels`.

## 3. Canary por peso

```bash
kubectl apply -f manifests/03-reviews-canary.yaml
dist "" 100   # ~80 v1 / ~20 v3
```

Edite os pesos para 50/50 e depois 0/100 e reaplique. Abra o Kiali (`istioctl dashboard kiali`) → Graph → bookinfo, com `../00-setup/traffic.sh` rodando, e veja a porcentagem nas arestas.

## 4. Ingress: redirect, rewrite, headers e CORS

```bash
kubectl apply -f manifests/04-httpbin-ingress.yaml
H='Host: httpbin.local'

curl -si -H "$H" http://localhost/old/qualquer | head -3         # 301 → /get
curl -si -H "$H" http://localhost/api/headers                   # /api/headers → /headers
                                                                # request tem X-Lab; response tem x-served-by
# CORS preflight respondido pelo Envoy (repare: sem x-envoy-upstream-service-time)
curl -s -D - -o /dev/null -X OPTIONS -H "$H" \
  -H 'Origin: https://example.com' -H 'Access-Control-Request-Method: GET' http://localhost/api/get
```

> **Pegadinha do CORS:** com uma origem não permitida (`https://evil.com`), o Envoy *não* bloqueia nada: ele só deixa de responder o preflight e encaminha ao backend (aparece `x-envoy-upstream-service-time`). Quem bloqueia é o navegador. Aqui o go-httpbin ainda responde com CORS próprio e "aceita" qualquer origem. Em produção, o CORS deve ficar num lugar só.

## 5. Kubernetes Gateway API

É a API padrão do Kubernetes para ingress, e o Istio a recomenda para instalações novas. Diferente do `Gateway` do Istio, que configura um Envoy existente, aqui o Istio **cria o Deployment e o Service do gateway** automaticamente.

```bash
kubectl apply -f manifests/05-gateway-api.yaml
kubectl -n sandbox get gateway.gateway.networking.k8s.io httpbin-gw   # PROGRAMMED=True
kubectl -n sandbox get deploy,svc httpbin-gw-istio                    # criados pelo Istio

kubectl -n sandbox port-forward svc/httpbin-gw-istio 8080:8080 &
for i in $(seq 50); do curl -s -H 'Host: httpbin.local' http://localhost:8080/api/hostname | grep -o '"hostname": "[^"]*'; done | sort | uniq -c
# ~45 go-httpbin (v1) / ~5 httpbin-v2-... → canary 90/10 pela HTTPRoute
kill %1
```

Compare `04-httpbin-ingress.yaml` e `05-gateway-api.yaml`: `rewrite` ↔ `URLRewrite`, `headers` ↔ `RequestHeaderModifier`, `weight` ↔ `backendRefs[].weight`.

> **Rancher Desktop:** cada `LoadBalancer` do k3s vira um pod `svclb` com hostPorts. O Service gerado expõe a porta 15021, que já pertence ao `istio-ingressgateway`. Por isso o manifest usa a anotação `networking.istio.io/service-type: ClusterIP` e o acesso é por port-forward. O `istioctl analyze` mostra um aviso `IST0107` sobre essa anotação; pode ignorar.

## 6. Injeção de falhas

Requer o exercício 2 aplicado (jason → reviews v2, que chama o ratings).

```bash
kubectl apply -f manifests/02-reviews-jason.yaml -f manifests/06a-fault-delay.yaml
time curl -s -b /tmp/jason http://localhost/productpage | grep -o 'Sorry, product reviews[^<.]*'
```

O resultado leva ~6s e o erro é no **reviews**, não no ratings. Por quê? O ratings atrasa 7s; o reviews v2 espera 10s, mas o productpage desiste do reviews após 3s e tenta mais 1 vez (3s + 3s). Foi assim que a injeção de falha revelou um bug real de timeouts no Bookinfo.

```bash
kubectl apply -f manifests/06b-fault-abort.yaml
curl -s -b /tmp/jason http://localhost/productpage | grep -o 'Ratings service is currently unavailable'
```

Agora a página carrega rápido e só as estrelas falham: a aplicação degrada com elegância.

## 7. Timeouts e retries

```bash
kubectl apply -f manifests/07-timeouts-retries.yaml

mcurl -o /dev/null -w '%{http_code} %{time_total}s\n' http://httpbin:8000/delay/5
# 504 em ~2s (o httpbin demoraria 5s)

mcurl -o /dev/null -w '%{http_code}\n' http://httpbin:8000/status/503
kubectl -n sandbox logs deploy/httpbin -c istio-proxy --since=30s | grep -c status/503   # 4 = 1 + 3 retries
kubectl -n sandbox logs deploy/curl -c istio-proxy --since=30s | grep -E 'status/503|delay/5'
```

Nos logs do cliente, veja os **response flags**: `UT` (upstream timeout) e `URX` (retries esgotados). São a primeira coisa a olhar num troubleshooting.

> O Istio já faz 2 retries por padrão. Retry em operação não idempotente (POST de pagamento...) é perigoso.

## 8. Circuit breaking

```bash
kubectl delete -f manifests/07-timeouts-retries.yaml   # retries mascarariam o efeito
kubectl apply -f manifests/08-circuit-breaker.yaml
fortio() { kubectl -n sandbox exec deploy/fortio-deploy -c fortio -- /usr/bin/fortio load -qps 0 -loglevel Warning "$@" 2>&1 | grep -E '^Code'; }

fortio -c 1 -n 20 http://httpbin:8000/get   # 100% 200
fortio -c 3 -n 30 http://httpbin:8000/get   # ~1/3 200, ~2/3 503

kubectl -n sandbox exec deploy/fortio-deploy -c istio-proxy -- pilot-agent request GET stats | grep httpbin.sandbox | grep overflow
```

O 503 é gerado pelo Envoy do **cliente**, sem chegar ao httpbin (flag `UO`). Isso protege o serviço sobrecarregado e falha rápido. Teste também `-c 2` e aumente `http1MaxPendingRequests`.

```bash
kubectl delete -f manifests/08-circuit-breaker.yaml
```

## 9. Load balancing e sticky session

O padrão do Istio é `LEAST_REQUEST`. Com `consistentHash`, o mesmo valor de header vai sempre para o mesmo pod:

```bash
kubectl -n bookinfo delete vs reviews --ignore-not-found     # sem subsets: hash entre todos os pods
kubectl apply -f manifests/09-sticky-session.yaml
kubectl -n bookinfo scale deploy reviews-v1 --replicas=3

rv() { mcurl $1 http://reviews.bookinfo:9080/reviews/0 | grep -o '"podname": "[^"]*'; }
for i in $(seq 10); do rv "-H x-user:alice"; done | sort | uniq -c   # sempre o mesmo pod
for i in $(seq 10); do rv "-H x-user:bob"; done | sort | uniq -c
for i in $(seq 10); do rv; done | sort | uniq -c                      # sem header: espalha
```

Outras opções: `httpCookie` (o Envoy gera o cookie), `useSourceIp`, `simple: ROUND_ROBIN | RANDOM`.

```bash
./reset.sh   # restaura a DestinationRule original e a escala
```

## 10. Traffic mirroring

Copia o tráfego real para uma versão nova sem afetar o cliente. Bom para testar uma v2 com carga de produção.

```bash
kubectl apply -f manifests/10-mirroring.yaml
mcurl -o /dev/null -w '%{http_code}\n' http://httpbin:8000/anything/mirror-test
kubectl -n sandbox logs deploy/httpbin    -c istio-proxy --since=30s | grep mirror-test
kubectl -n sandbox logs deploy/httpbin-v2 -c istio-proxy --since=30s | grep mirror-test   # a cópia chegou
```

> Cuidado: requisições espelhadas com efeito colateral (escrita em banco, envio de e-mail) são executadas de verdade.

## 11. Controle de saída e o recurso `Sidecar`

Por padrão a mesh é `ALLOW_ANY`: os pods saem para qualquer lugar.

```bash
mcurl -o /dev/null -w '%{http_code}\n' https://www.google.com           # 200
istioctl pc clusters deploy/curl -n sandbox | wc -l                     # ~60: o Envoy conhece a mesh inteira

kubectl apply -f manifests/11a-sidecar-registry-only.yaml
mcurl -o /dev/null -w '%{http_code}\n' https://www.google.com           # falha (curl exit 35)
mcurl -o /dev/null -w '%{http_code}\n' http://httpbin.org/get           # 502 (BlackHoleCluster)
istioctl pc clusters deploy/curl -n sandbox | wc -l                     # ~38: só sandbox + istio-system

kubectl apply -f manifests/11b-serviceentry.yaml
mcurl -o /dev/null -w '%{http_code}\n' http://httpbin.org/get           # 200
mcurl -o /dev/null -w '%{http_code}\n' https://httpbin.org/get          # 200
```

Duas lições: `REGISTRY_ONLY` + `ServiceEntry` funciona como uma allowlist de saída, e `Sidecar.egress.hosts` reduz a config de cada Envoy (essencial em clusters grandes).

> O `Sidecar` no namespace `sandbox` também esconde o `bookinfo`. Teste `mcurl http://reviews.bookinfo:9080/reviews/0`.

## 12. Egress gateway

Concentra a saída num ponto único (auditoria, IP de saída fixo, políticas). Requer o exercício 11b.

```bash
istioctl install -f ../00-setup/istio-operator.yaml -f manifests/12-egress-gateway-operator.yaml -y
kubectl apply -f manifests/12-egress-gateway.yaml

mcurl -o /dev/null -w '%{http_code}\n' http://httpbin.org/headers
kubectl -n istio-system logs deploy/istio-egressgateway --since=30s | grep /headers   # passou pelo egress
```

O VirtualService tem duas regras: `gateways: [mesh]` (sidecar → egress gateway) e `gateways: [istio-egressgateway]` (egress gateway → destino real).

> Isso não é uma barreira de segurança por si só: um pod pode tentar sair direto. Para garantir, combine com `NetworkPolicy` e `AuthorizationPolicy` (módulo 02).

---

## Checklist de conclusão

- [ ] Sei a diferença entre VirtualService, DestinationRule e Gateway
- [ ] Fiz canary por peso e por header
- [ ] Expus um serviço com o Gateway do Istio e com a Gateway API
- [ ] Entendi o bug de timeouts do Bookinfo revelado pela injeção de falhas
- [ ] Sei ler os response flags do access log (`UT`, `URX`, `UO`, `UH`, `NR`)
- [ ] Vi o circuit breaker gerar 503 no lado do cliente
- [ ] Bloqueei a saída com `REGISTRY_ONLY` e liberei com `ServiceEntry`

## Limpeza

```bash
./reset.sh
# Remover o egress gateway (opcional):
istioctl install -f ../00-setup/istio-operator.yaml -y
```
