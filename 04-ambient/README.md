# 04 — Ambient mode

**Objetivo:** entender a mesh **sem sidecar**: o ztunnel (L4, um por nó) e o waypoint (L7, opcional, um por namespace), o que cada um faz e não faz, como convivem com sidecars e como migrar uma aplicação.

| # | Exercício | O que mostra |
|---|---|---|
| 1 | mTLS automático e STRICT | Identidade e criptografia sem sidecar |
| 2 | Autorização L4 no ztunnel | O que o ztunnel consegue (e não consegue) aplicar |
| 3 | Waypoint e autorização L7 | `targetRefs`, defesa em profundidade |
| 4 | Roteamento L7 | HTTPRoute (GAMMA) e VirtualService via waypoint |
| 5 | Observabilidade | Métricas TCP (ztunnel) × HTTP (waypoint) |
| 6 | Ingress → ambient | `istio.io/ingress-use-waypoint` |
| 7 | Migrar o Bookinfo de sidecar para ambient | Passo a passo, L7 e consumo de recursos |

## Arquitetura

```
                 modo sidecar                                 modo ambient
  ┌───────────────────────────┐            ┌────────────┐                  ┌────────────┐
  │ pod A        pod B        │            │ pod A      │                  │ pod B      │
  │ [app|envoy]→[envoy|app]   │            │ [app]      │                  │ [app]      │
  └───────────────────────────┘            └──┬─────────┘                  └─────▲──────┘
   L4 + L7 em cada pod                        │ istio-cni redireciona            │
                                          ┌───▼──────┐   HBONE (mTLS,      ┌─────┴────┐
                                          │ ztunnel  │──── HTTP CONNECT ──▶│ ztunnel  │
                                          │ (nó 1)   │     porta 15008)    │ (nó 2)   │
                                          └───┬──────┘                     └──────────┘
                                              │  só se o serviço usa waypoint
                                              └──────▶ [ waypoint (Envoy) ] ──▶ ...
                                                        L7: rotas, retries, authz HTTP
```

| | Sidecar | ztunnel | waypoint |
|---|---|---|---|
| Onde roda | em cada pod | 1 por nó (DaemonSet) | 1 por namespace ou service account |
| Camada | L4 + L7 | **só L4**: mTLS, identidade, authz por principal/namespace/porta, métricas TCP | L7: HTTP, rotas, fault, retries, authz por path/método/JWT |
| Reinicia o pod ao entrar na mesh | sim | **não** | não |
| Política mira | `selector` | `selector` | `targetRefs` (Service ou Gateway) |

## Preparação

Requer o módulo 00. Rode o `reset.sh` dos módulos anteriores.

```bash
./setup.sh
```

O script:
1. Corrige o mount `/run` na VM do Rancher Desktop (veja a nota abaixo).
2. Reinstala o control plane com o perfil **ambient** (`ambient-operator.yaml`: istio-cni + ztunnel, ajustes para k3s), preservando o egress gateway se existir.
3. Cria o namespace `ambient` (label `istio.io/dataplane-mode=ambient`) com httpbin, httpbin-v2 e curl, e o namespace `outside` (fora da mesh) com curl.

> **Rancher Desktop (runtime dockerd):** o istio-cni entra em CrashLoop com `path /var/run/netns is mounted on /run but it is not a shared or slave mount`. A correção é `rdctl shell sudo mount --make-shared /run`, que o `setup.sh` aplica, mas ela **se perde quando a VM reinicia**. Depois de reiniciar o Rancher, rode o `setup.sh` de novo. Para tornar permanente (não testado neste lab), crie `~/Library/Application Support/rancher-desktop/lima/_config/override.yaml`:
>
> ```yaml
> provision:
>   - mode: system
>     script: |
>       #!/bin/sh
>       mount --make-shared /run
> ```

Os sidecars continuam funcionando: os dois modos convivem na mesma mesh.

> O perfil ambient troca as imagens do Istio pela variante **distroless** (`1.31.0-distroless`). Os pods recriados depois disso, sidecars incluídos, ficam sem shell e sem `curl` no container `istio-proxy`. Para testar chamadas "de dentro" de um pod, use o container da aplicação ou um pod `curl`.

```bash
kubectl -n ambient get pods                    # READY 1/1: sem sidecar
kubectl -n istio-system get ds ztunnel istio-cni-node
istioctl ztunnel-config workloads | grep -E 'NAMESPACE|ambient|outside|bookinfo'
#   ambient  → PROTOCOL HBONE (na mesh, via ztunnel)
#   bookinfo → TCP (sidecar), outside → TCP (fora da mesh)
```

Atalho:

```bash
# uso: from <namespace> <args do curl>  → status HTTP (ou 000 + exit code se a conexão cair)
from() { kubectl -n "$1" exec deploy/curl -c curl -- curl -s -o /dev/null -m 5 -w '%{http_code}\n' "${@:2}"; }
```

Para voltar ao estado inicial: `./reset.sh`.

---

## 1. mTLS sem sidecar

```bash
from ambient http://httpbin:8000/get            # 200
from outside http://httpbin.ambient:8000/get    # 200 (PERMISSIVE aceita texto puro)
from sandbox http://httpbin.ambient:8000/get    # 200 (sidecar → ambient: interoperam)

kubectl -n istio-system logs ds/ztunnel --since=30s | grep 'connection complete' | tail -3
#   src.identity="spiffe://cluster.local/ns/ambient/sa/curl" dst.addr=...:15008 (HBONE)
#   a conexão do outside não tem src.identity
```

O app não sabe de nada: abre uma conexão TCP comum. O istio-cni redireciona para o ztunnel do nó, que faz o mTLS com o ztunnel do destino.

```bash
kubectl apply -f manifests/01-mtls-strict.yaml
from ambient http://httpbin:8000/get            # 200
from outside http://httpbin.ambient:8000/get    # 000 (exit 56): conexão recusada
from sandbox http://httpbin.ambient:8000/get    # 200: o sidecar também faz mTLS
kubectl delete -f manifests/01-mtls-strict.yaml
```

## 2. Autorização L4 no ztunnel

```bash
kubectl apply -f manifests/02a-l4-policy.yaml
from ambient http://httpbin:8000/get            # 200: principal liberado
from sandbox http://httpbin.ambient:8000/get    # 503: o sidecar recebe a recusa e responde 503
from outside http://httpbin.ambient:8000/get    # 000: sem identidade
```

Agora uma regra **L7** sem waypoint:

```bash
kubectl apply -f manifests/02b-l7-policy-no-waypoint.yaml   # mesmo nome: substitui a 02a
from ambient http://httpbin:8000/get            # 000: até o /get, que estaria liberado!
kubectl -n istio-system logs ds/ztunnel --since=30s | grep error | tail -1
#   error="http status: 401 Unauthorized"
```

> O ztunnel não entende HTTP. Uma regra ALLOW com `paths` nunca casa, então **tudo** é negado. É o erro mais comum ao levar políticas do modo sidecar para o ambient. Políticas L7 precisam de waypoint e de `targetRefs` (exercício 3).

```bash
kubectl delete -f manifests/02b-l7-policy-no-waypoint.yaml
```

## 3. Waypoint e autorização L7

```bash
kubectl apply -f manifests/03a-waypoint.yaml      # ou: istioctl waypoint apply -n ambient
kubectl -n ambient wait --for=condition=Programmed gateway/waypoint
kubectl label ns ambient istio.io/use-waypoint=waypoint
kubectl -n ambient get pods,svc -l gateway.networking.k8s.io/gateway-name=waypoint
istioctl ztunnel-config services -n ambient       # coluna WAYPOINT preenchida
```

```bash
kubectl apply -f manifests/03b-l7-policy-waypoint.yaml
from ambient http://httpbin:8000/get              # 200
from ambient http://httpbin:8000/ip               # 403 RBAC: access denied (agora é HTTP!)
from ambient -X POST http://httpbin:8000/get      # 403
from ambient http://httpbin-v2:8000/ip            # 200: a política é só do Service httpbin
kubectl -n ambient logs deploy/waypoint --tail=3  # access log do waypoint
```

**Sidecars pulam o waypoint.** Teste com o cliente do namespace `sandbox`:

```bash
from sandbox http://httpbin.ambient:8000/ip       # 200: furou a política L7!
```

Neste lab (Istio 1.31), o sidecar envia direto ao pod do destino, e o waypoint nunca vê a requisição (`kubectl -n ambient logs deploy/waypoint | grep -c sandbox` → 0). O mesmo vale para quem chama o **IP do pod** em vez do Service. A defesa é uma política L4 no ztunnel aceitando só o waypoint:

```bash
POD_IP=$(kubectl -n ambient get pod -l app=httpbin -o jsonpath='{.items[0].status.podIP}')
from ambient http://$POD_IP:8080/ip               # 200: bypass pelo IP

kubectl apply -f manifests/03c-l4-allow-waypoint.yaml
from ambient http://$POD_IP:8080/ip               # 000: bloqueado no ztunnel
from sandbox http://httpbin.ambient:8000/ip       # 503: sidecar bloqueado
from ambient http://httpbin:8000/get              # 200: via waypoint continua ok
```

> Com waypoint, o servidor vê a identidade do **waypoint** (`ns/ambient/sa/waypoint`) no mTLS, e não a do cliente original. Por isso a política com o principal do cliente vai no waypoint (`targetRefs`), e a do ztunnel só libera o waypoint.

```bash
kubectl delete -f manifests/03b-l7-policy-waypoint.yaml -f manifests/03c-l4-allow-waypoint.yaml
```

## 4. Roteamento L7

### 4a. HTTPRoute com parentRef no Service (GAMMA)

```bash
kubectl apply -f manifests/04a-httproute-canary.yaml
kubectl -n ambient get httproute httpbin -o jsonpath='{range .status.parents[*].conditions[*]}{.type}={.status} {end}{"\n"}'
#   Accepted=True ResolvedRefs=True ResolvedWaypoints=True

kubectl -n ambient exec deploy/curl -- sh -c 'for i in $(seq 50); do curl -s http://httpbin:8000/hostname; done' | grep -o '"hostname": "[^"]*' | sort | uniq -c
#   ~45 go-httpbin / ~5 httpbin-v2-...
kubectl -n ambient exec deploy/curl -- curl -s -H 'x-version: v2' http://httpbin:8000/hostname   # sempre v2
```

### 4b. VirtualService (fault + timeout)

```bash
kubectl apply -f manifests/04b-virtualservice-fault.yaml
kubectl -n ambient exec deploy/curl -- sh -c 'for i in $(seq 30); do curl -s -o /dev/null -w "%{http_code}\n" http://httpbin-v2:8000/get; done' | sort | uniq -c
#   ~21 200 / ~9 503
kubectl -n ambient exec deploy/curl -- curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' http://httpbin-v2:8000/delay/3
#   504 em ~1s (ou 503 se cair nos 30% de abort)
kubectl -n ambient logs deploy/waypoint --since=1m | grep httpbin-v2 | awk '{print $5,$6,$7}' | sort | uniq -c
#   503 FI fault_filter_abort / 504 UT response_timeout
```

> O atraso de um `fault.delay` **não** conta no `timeout` da mesma rota: o filtro de fault roda antes do router do Envoy. No módulo 01, o timeout que "pegou" o delay era o da aplicação (productpage), um salto antes.

## 5. Observabilidade

```bash
source ../03-observability/helpers.sh
kubectl -n ambient exec deploy/curl -- sh -c 'for i in $(seq 20); do curl -s -o /dev/null http://httpbin:8000/get; done'; sleep 20

# HTTP: só existe onde há waypoint → reporter="waypoint"
promql 'sum(increase(istio_requests_total{destination_service_namespace="ambient"}[2m])) by (reporter, source_workload, destination_workload, response_code)'

# TCP: o ztunnel reporta conexões e bytes
promql 'sum(increase(istio_tcp_connections_opened_total{destination_workload_namespace="ambient"}[2m])) by (reporter, source_workload, destination_workload)'
#   curl → waypoint e waypoint → httpbin: dois saltos
```

Sem waypoint, um namespace ambient só tem métricas TCP: nada de status code, latência HTTP ou traces. No Kiali, os workloads ambient aparecem com o ícone de ambient, e o waypoint aparece no grafo.

## 6. Ingress gateway → serviço ambient

```bash
kubectl apply -f manifests/06-ingress.yaml
for i in $(seq 20); do curl -s -H 'Host: ambient.local' localhost/hostname | grep -o '"hostname": "[^"]*'; echo; done | sort | uniq -c
#   20 go-httpbin: o canary da HTTPRoute (4a) NÃO foi aplicado
kubectl -n ambient logs deploy/waypoint --since=30s | grep -c ambient.local    # 0
```

Como os sidecars, o ingress gateway vai direto ao pod. Para ele passar pelo waypoint:

```bash
kubectl -n ambient label svc httpbin istio.io/ingress-use-waypoint=true
for i in $(seq 40); do curl -s -H 'Host: ambient.local' localhost/hostname | grep -o '"hostname": "[^"]*'; echo; done | sort | uniq -c
#   ~36 go-httpbin / ~4 httpbin-v2: agora o canary vale
kubectl -n ambient logs deploy/waypoint --since=30s | grep -c ambient.local    # > 0
```

```bash
./reset.sh
```

## 7. Migrar o Bookinfo de sidecar para ambient

**1. Meça o custo dos sidecars:**

```bash
kubectl top pods -n bookinfo --containers | awk 'NR==1 || /istio-proxy/'
#   6 × istio-proxy ≈ 60Mi cada → ~366Mi no total
```

**2. Troque o modo do namespace e recrie os pods:**

```bash
kubectl label ns bookinfo istio-injection- istio.io/dataplane-mode=ambient
kubectl -n bookinfo rollout restart deploy
kubectl -n bookinfo get pods -w           # 1/1. Erros na página durante a troca são esperados
curl -s localhost/productpage | grep -oE 'reviews-v[0-9]'
istioctl ztunnel-config workloads -n bookinfo   # HBONE
```

> Num namespace já ambient, um **pod novo** entra na mesh sem restart. O restart aqui serve só para **remover** o sidecar.

**3. As regras L7 pararam de funcionar:**

```bash
dist() { for i in $(seq 20); do curl -s localhost/productpage | grep -oE 'reviews-v[0-9]' | head -1; done | sort | uniq -c; }
kubectl apply -f ../01-traffic-management/manifests/01-reviews-v1.yaml
dist    # v1, v2 e v3 misturados: o VirtualService foi ignorado
```

**4. Adicione o waypoint:**

```bash
kubectl apply -f manifests/07-bookinfo-waypoint.yaml
kubectl -n bookinfo wait --for=condition=Programmed gateway/waypoint
kubectl label ns bookinfo istio.io/use-waypoint=waypoint
sleep 10; dist    # 20 reviews-v1
```

**5. Compare os recursos:**

```bash
kubectl top pods -n istio-system | grep -E 'NAME|ztunnel|cni'
kubectl top pods -n bookinfo | grep waypoint
```

| | Memória |
|---|---|
| Sidecar: 6 × istio-proxy | ~366Mi (cresce com o nº de pods) |
| Ambient: ztunnel (por **nó**) | ~15Mi |
| Ambient: waypoint (por **namespace**, só se precisar de L7) | ~64Mi |

O istio-cni (~80Mi) também é por nó e não depende do número de pods.

> **Checklist de migração real:** (1) políticas com regras L7 e `selector` → reescrever com `targetRefs` no waypoint; (2) VirtualService/DestinationRule → exigem waypoint; (3) clientes com sidecar e o ingress pulam o waypoint → `ingress-use-waypoint` e/ou migrar os clientes também; (4) EnvoyFilter/WasmPlugin que miram pods não se aplicam; (5) migre namespace por namespace, validando no Kiali.

**6. Volte para sidecar** (os próximos módulos assumem o Bookinfo com sidecar):

```bash
./rollback-bookinfo.sh
```

---

## Checklist de conclusão

- [ ] Sei o que o ztunnel faz (L4) e o que precisa de waypoint (L7)
- [ ] Vi o mTLS e a identidade SPIFFE de um pod sem sidecar nos logs do ztunnel
- [ ] Entendi por que uma regra com `paths` sem waypoint nega tudo
- [ ] Usei `targetRefs` para aplicar política L7 no waypoint
- [ ] Sei que sidecars, o ingress e chamadas por IP pulam o waypoint, e como me proteger
- [ ] Fiz canary com HTTPRoute (GAMMA) e fault/timeout com VirtualService no ambient
- [ ] Migrei o Bookinfo de sidecar para ambient e comparei o consumo

## Limpeza

```bash
./reset.sh                          # políticas, rotas, waypoints; Bookinfo volta para sidecar
kubectl delete ns ambient outside
# Remover o modo ambient (istio-cni e ztunnel):
istioctl install -y -f ../00-setup/istio-operator.yaml \
  -f ../01-traffic-management/manifests/12-egress-gateway-operator.yaml   # se usa o egress gateway
```
