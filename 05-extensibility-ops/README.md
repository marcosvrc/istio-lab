# 05 — Extensibilidade e operação

**Objetivo:** estender o Envoy quando a API do Istio não basta (rate limiting, EnvoyFilter, WasmPlugin), entender os riscos de cada mecanismo, e operar a mesh: upgrade canário do control plane e ajuste dos sidecars.

| # | Exercício | Recursos |
|---|---|---|
| 1 | Rate limit local | `EnvoyFilter` + `envoy.filters.http.local_ratelimit` |
| 2 | Rate limit global | serviço `envoyproxy/ratelimit` + Redis, `EnvoyFilter` no ingress |
| 3 | EnvoyFilter: Lua e o que acontece quando o patch está errado | `envoy.filters.http.lua`, NACK |
| 4 | WasmPlugin | plugin `basic_auth` (OCI) |
| 5 | Upgrade canário do control plane | `revision`, revision tags (`istioctl tag`) |
| 6 | Tuning do sidecar | anotações de recursos, `concurrency`, native sidecars |

## Conceitos-chave

- **Ordem de preferência para estender:** API do Istio (VirtualService, AuthorizationPolicy, Telemetry...) → `WasmPlugin` → `EnvoyFilter`. Quanto mais para a direita, mais você depende de detalhes internos do Envoy.
- **EnvoyFilter** é um patch na config que o istiod gera. Nem o Kubernetes nem o istiod validam o conteúdo: quem valida é o Envoy, na hora de aplicar. Nomes de filtros, campos e a estrutura dos listeners mudam entre versões, e por isso todo EnvoyFilter é um risco no upgrade.
- **Rate limit local** fica em cada Envoy (um balde de tokens por proxy). **Global** é um serviço central que todas as réplicas consultam, com o contador no Redis.
- **Revision**: cada control plane instalado com `revision` tem o seu istiod e o seu webhook de injeção. Os namespaces escolhem a revisão pela label `istio.io/rev`. Uma **revision tag** é um apelido estável (`prod-stable`) que aponta para uma revisão: para promover, você muda o alvo da tag, e não as labels de cada namespace.

## Preparação

Requer o módulo 00. Rode o `reset.sh` dos módulos anteriores.

```bash
./setup.sh
```

O script:
1. Recria pods que ficaram presos no init container `istio-validation` (acontece com o istio-cni do módulo 04 depois de reiniciar a VM).
2. Instala o serviço de rate limit e o Redis no namespace `ratelimit`, com as regras de `manifests/base/ratelimit-config.yaml`.
3. Expõe o httpbin no ingress com o Host `httpbin.local`.
4. Baixa o `istioctl` **1.31.3** para `bin/` (usado no exercício 5; a pasta está no `.gitignore`).

Atalho:

```bash
# uso: from <args do curl>  → status HTTP de uma chamada de dentro da mesh (pod curl do sandbox)
from() { kubectl -n sandbox exec deploy/curl -c curl -- curl -s -o /dev/null -w '%{http_code}\n' "$@"; }
```

Para voltar ao estado inicial: `./reset.sh`.

---

## 1. Rate limit local

```bash
kubectl apply -f manifests/01-local-ratelimit.yaml
kubectl -n sandbox exec deploy/curl -c curl -- sh -c 'for i in $(seq 15); do curl -s -o /dev/null -w "%{http_code}\n" http://httpbin:8000/get; done' | sort | uniq -c
#   10 200
#    5 429
kubectl -n sandbox exec deploy/curl -c curl -- curl -s -D - -o /dev/null http://httpbin:8000/get | grep -iE '^HTTP|x-local'
#   HTTP/1.1 429 Too Many Requests
#   x-local-rate-limit: true
```

Quem limita é o sidecar do **servidor**. Compare os access logs dos dois lados:

```bash
kubectl -n sandbox logs deploy/httpbin -c istio-proxy --tail=1 | awk '{print $5,$6,$7}'   # 429 RL local_rate_limited
kubectl -n sandbox logs deploy/curl -c istio-proxy --tail=1 | awk '{print $5,$6,$7}'      # 429 - via_upstream
```

O balde tem 10 tokens e enche a cada 30s. Espere e rode de novo: volta a passar.

> **Cada Envoy tem o seu balde.** Com 3 réplicas do httpbin, o limite efetivo é 30 a cada 30s. Para um limite que valha para o serviço inteiro (por usuário, por API key), use o rate limit global.

O filtro tem dois controles: `filter_enabled` (conta os tokens) e `filter_enforced` (responde 429). Com `filter_enforced` em 0%, ele roda em modo *shadow*: conta, mas não bloqueia. Isso serve para medir o efeito antes de ligar.

```bash
kubectl delete -f manifests/01-local-ratelimit.yaml
```

## 2. Rate limit global

As regras ficam no serviço, e não no Envoy:

```bash
kubectl -n ratelimit get cm ratelimit-config -o jsonpath='{.data.config\.yaml}'
#   domain: httpbin
#   user (qualquer valor) → 3/min;  user=vip → 10/min
```

O EnvoyFilter faz duas coisas no ingress: insere o filtro `envoy.filters.http.ratelimit` (que consulta o serviço por gRPC) e, no virtual host `httpbin.local:80`, define a *action* que transforma o header `x-user` no descritor `user=<valor>`.

```bash
kubectl apply -f manifests/02-global-ratelimit.yaml
for u in alice alice alice alice bob vip vip vip vip; do
  printf '%-6s' $u; curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: httpbin.local' -H "x-user: $u" localhost/get
done
#   alice 200 / alice 200 / alice 200 / alice 429   ← 3 por minuto, por usuário
#   bob   200                                       ← balde próprio
#   vip   200 × 4                                   ← regra específica (10/min)

curl -s -D - -o /dev/null -H 'Host: httpbin.local' -H 'x-user: carol' localhost/get | grep -i ratelimit
#   x-ratelimit-limit: 3, 3;w=60
#   x-ratelimit-remaining: 2
#   x-ratelimit-reset: 52
```

Sem o header não existe descritor, e a requisição **não é limitada**. O Bookinfo também não é afetado, porque as actions estão só no virtual host do httpbin:

```bash
for i in $(seq 5); do curl -s -o /dev/null -w '%{http_code} ' -H 'Host: httpbin.local' localhost/get; done; echo   # 200 × 5
```

**E se o serviço de rate limit cair?** Com `failure_mode_deny: false` (fail open), tudo passa:

```bash
kubectl -n ratelimit scale deploy ratelimit --replicas=0
for i in 1 2 3 4 5; do curl -s -o /dev/null -w '%{http_code} ' -H 'Host: httpbin.local' -H 'x-user: alice' localhost/get; done; echo   # 200 × 5
kubectl -n ratelimit scale deploy ratelimit --replicas=1
```

> Fail open protege a disponibilidade, e fail closed protege o backend. Para limites de segurança (força bruta em login), prefira fail closed e trate o serviço de rate limit como crítico (réplicas, Redis com alta disponibilidade).

```bash
kubectl delete -f manifests/02-global-ratelimit.yaml
```

## 3. EnvoyFilter

### 3a. Filtro Lua

```bash
kubectl apply -f manifests/03a-lua-headers.yaml
kubectl -n sandbox exec deploy/curl -c curl -- curl -s -D - http://httpbin:8000/headers | grep -i -A1 lua
#   x-lua-response: 0.5ms                     ← adicionado na volta
#   "X-Lua-Request": [ "istio-lab"            ← adicionado na ida, visto pelo httpbin
```

Veja onde o patch entrou: o filtro Lua fica antes do router na cadeia HTTP do listener de entrada.

```bash
istioctl proxy-config listeners deploy/httpbin -n sandbox --port 15006 -o json \
  | jq -r 'first(.. | objects | select(has("httpFilters"))) | [.httpFilters[].name] | join(" → ")'
#   istio.metadata_exchange → envoy.filters.http.grpc_stats → envoy.filters.http.fault →
#   envoy.filters.http.cors → istio.stats → envoy.filters.http.lua → envoy.filters.http.router
```

O `INSERT_BEFORE` do router é relativo: se outro EnvoyFilter também mexer na cadeia, a ordem final depende da ordem em que o istiod aplica os patches. O campo `priority` torna essa ordem explícita.

### 3b. Um EnvoyFilter errado

O `03b` tem um erro de digitação (`inline_strin`). Ainda assim, ele é aceito:

```bash
kubectl apply -f manifests/03b-broken-envoyfilter.yaml     # created
istioctl analyze -n sandbox
#   só avisos genéricos: IST0133 (EnvoyFilter expõe detalhes internos) e
#   IST0151 (sem priority). Nada sobre o campo errado.
```

Quem recusa é o Envoy (**NACK**). Ele mantém a config anterior, e a única pista fica nos logs:

```bash
kubectl -n istio-system logs deploy/istiod --since=1m | grep 'ACK ERROR' | tail -1
#   ADS:LDS: ACK ERROR httpbin-...: Error adding/updating listener(s) virtualInbound:
#   Proto constraint validation failed (LuaValidationError.DefaultSourceCode: ... "specifier", reason: is required)
from http://httpbin:8000/get    # 200: o pod que já existia continua funcionando com a config antiga
```

O perigo aparece no **próximo pod**. Ele não tem uma config anterior para manter:

```bash
kubectl -n sandbox rollout restart deploy/httpbin; sleep 40
kubectl -n sandbox get pods -l app=httpbin
#   httpbin-<antigo>   2/2  Running
#   httpbin-<novo>     0/2  Init:1/2     ← o istio-proxy nunca fica pronto, e o app nem inicia
kubectl -n sandbox logs <pod novo> -c istio-proxy | grep 'NOT ready' | tail -1
#   Envoy proxy is NOT ready: config received from XDS server, but was rejected: ... lds updates: 0 successful, 1 rejected
```

O rollout trava (o pod antigo segue atendendo). Num deploy, num autoscaling ou num restart do nó, os pods novos não sobem.

```bash
kubectl delete -f manifests/03b-broken-envoyfilter.yaml
kubectl -n sandbox rollout status deploy/httpbin    # agora completa
kubectl delete -f manifests/03a-lua-headers.yaml
```

> **Checklist para EnvoyFilter:** (1) existe API do Istio que resolva? (2) use `workloadSelector` e o namespace mais restrito possível (no `istio-system` sem selector, ele vale para a mesh inteira); (3) depois de aplicar, procure `ACK ERROR` no istiod; (4) inventarie todos antes de cada upgrade (`kubectl get envoyfilter -A`) e teste na versão nova; (5) o `istioctl x precheck` da versão nova avisa sobre alguns casos, mas não todos.

## 4. WasmPlugin

Um módulo WebAssembly roda dentro do Envoy, isolado. O `istio-agent` de cada pod baixa a imagem OCI e entrega o `.wasm` ao Envoy, sem EnvoyFilter. O plugin de exemplo exige Basic Auth em `/anything/admin`:

```bash
kubectl apply -f manifests/04-wasm-basic-auth.yaml
sleep 15    # o istio-agent baixa a imagem do ghcr.io
kubectl -n sandbox logs deploy/httpbin -c istio-proxy | grep wasm | tail -1
#   wasm  fetching image istio-ecosystem/wasm-extensions/basic_auth from registry ghcr.io with tag 1.12.0

from http://httpbin:8000/anything/admin                        # 401
from -u admin:istio-lab http://httpbin:8000/anything/admin     # 200
from -u admin:errada http://httpbin:8000/anything/admin        # 401
from http://httpbin:8000/get                                   # 200: fora do prefixo
from -X DELETE http://httpbin:8000/anything/admin              # 200: método fora da regra
kubectl -n sandbox exec deploy/curl -c curl -- curl -s -D - -o /dev/null http://httpbin:8000/anything/admin | grep -i www-auth
#   www-authenticate: Basic realm=istio
```

> Nas primeiras requisições depois do `apply`, o plugin ainda não está carregado e o tráfego passa. Para segurança, não conte com o plugin antes de confirmar que ele está ativo. Se o download falhar, o padrão do `failStrategy` (FAIL_CLOSE) nega o tráfego.

| | WasmPlugin | EnvoyFilter |
|---|---|---|
| API | estável no Istio (`selector`, `phase`, `priority`, `targetRefs`) | patch na estrutura interna do Envoy |
| Erro de config | o plugin falha isolado (`failStrategy`) | NACK do listener inteiro |
| Distribuição | imagem OCI versionada | YAML inline |
| Custo | mais CPU e memória que um filtro nativo | nativo |

```bash
kubectl delete -f manifests/04-wasm-basic-auth.yaml
```

## 5. Upgrade canário do control plane

Em vez de atualizar o istiod "no lugar", instale a versão nova **ao lado** da atual, mova os namespaces um por um e só então remova a antiga. Aqui o canário é o 1.31.3 (o `bin/istioctl` baixado pelo setup), ao lado do 1.31.0 instalado.

**1. Verifique e instale o canário** com o istioctl da versão **nova**:

```bash
bin/istioctl x precheck
bin/istioctl install -y -f ../00-setup/istio-operator.yaml -f manifests/05-canary-operator.yaml
kubectl -n istio-system get deploy -l app=istiod
#   istiod          1/1   ← 1.31.0 (revisão "default")
#   istiod-1-31-3   1/1   ← canário
```

O overlay usa a meshConfig do lab, mas instala **só** o istiod. Os gateways, o istio-cni e o ztunnel continuam com o control plane atual. As CRDs são atualizadas para a versão nova, o que é normal: elas são compatíveis com a anterior.

**2. Crie as revision tags** e associe os namespaces a elas:

```bash
bin/istioctl tag set prod-stable --revision default
bin/istioctl tag set prod-canary --revision 1-31-3
kubectl label ns sandbox  istio-injection- istio.io/rev=prod-stable --overwrite
kubectl label ns bookinfo istio-injection- istio.io/rev=prod-canary --overwrite
bin/istioctl tag list
#   TAG         REVISION NAMESPACES
#   prod-canary 1-31-3   bookinfo
#   prod-stable default  sandbox
```

> A label `istio-injection=enabled` tem prioridade sobre `istio.io/rev`, por isso ela é removida.

**3. Mova o Bookinfo para o canário** recriando os pods:

```bash
kubectl -n bookinfo rollout restart deploy
bin/istioctl proxy-status --revision 1-31-3 | awk '{print $1, $3, $4}'
#   productpage-v1-....bookinfo  istiod-1-31-3-...  1.31.3
curl -s -o /dev/null -w '%{http_code}\n' localhost/productpage                   # 200: ingress 1.31.0 → bookinfo 1.31.3
from http://productpage.bookinfo:9080/productpage                                # 200: sandbox 1.31.0 → bookinfo 1.31.3
```

> O `proxy-status` mostra só os proxies da revisão consultada (sem `--revision`, a `default`). Valide a versão nova com tráfego real e com o Kiali antes de seguir.

**4. Promova:** mude o alvo da tag `prod-stable`. Os namespaces não mudam:

```bash
bin/istioctl tag set prod-stable --revision 1-31-3 --overwrite
kubectl -n sandbox rollout restart deploy
bin/istioctl proxy-status --revision 1-31-3 | grep -c sandbox    # 4 (o ext-authz não tem sidecar)
```

Num upgrade real, os próximos passos seriam: atualizar os gateways (`bin/istioctl install` da config completa, ou gateways com revisão própria), apontar a tag `default` para a nova revisão (`bin/istioctl tag set default --revision 1-31-3 --overwrite`) e remover a antiga com `istioctl uninstall --revision default`.

**5. Rollback.** Neste lab, volte para o 1.31.0, porque os outros módulos usam o `istioctl` da sua máquina:

```bash
./reset.sh
#   namespaces de volta para istio-injection=enabled, pods recriados,
#   tags removidas e "bin/istioctl uninstall --revision 1-31-3"
istioctl proxy-status | awk 'NR>1 {print $4}' | sort | uniq -c   # todos 1.31.0
```

O rollback é o mesmo movimento ao contrário: apontar a tag (ou a label) para a revisão antiga e reiniciar os pods. Por isso o canário é seguro: as duas versões ficam disponíveis até o fim.

## 6. Tuning do sidecar

### 6a. Recursos e concurrency por workload

```bash
kubectl apply -f manifests/06a-proxy-tuning.yaml
kubectl -n sandbox rollout status deploy/httpbin-tuned
for d in httpbin httpbin-tuned; do
  echo "$d: $(kubectl -n sandbox get pod -l app=$d -o json | jq -c '[.items[0].spec.initContainers[] | select(.name=="istio-proxy") | .resources][0]')" \
       "concurrency=$(kubectl -n sandbox exec deploy/$d -c istio-proxy -- pilot-agent request GET server_info | jq .command_line_options.concurrency)"
done
#   httpbin:       {"limits":{"cpu":"2","memory":"1Gi"},"requests":{"cpu":"10m","memory":"40Mi"}} concurrency=2
#   httpbin-tuned: {"limits":{"cpu":"500m","memory":"128Mi"},"requests":{"cpu":"20m","memory":"32Mi"}} concurrency=1
kubectl top pods -n sandbox --containers | grep -E 'NAME|istio-proxy'
```

| Ajuste | Onde | Efeito |
|---|---|---|
| `sidecar.istio.io/proxyCPU` / `proxyMemory` (e `...Limit`) | anotação do pod | requests/limits do `istio-proxy` |
| `concurrency` | `proxy.istio.io/config` | threads do Envoy. Cada thread tem as suas conexões e buffers |
| `terminationDrainDuration` | `proxy.istio.io/config` | tempo de drenagem no SIGTERM (padrão 5s) |
| recurso `Sidecar` (módulo 01) | namespace/workload | menos clusters e rotas = menos memória |

> A memória do sidecar cresce com o **tamanho da mesh** (quantos serviços e endpoints ele conhece), e não com o tráfego. Em meshes grandes, o recurso `Sidecar` costuma economizar mais do que os limits.

### 6b. Native sidecars: ordem de início e Jobs

Neste cluster, o `istio-proxy` é um **native sidecar**: um initContainer com `restartPolicy: Always`, que sobe antes do app e termina depois dele.

```bash
kubectl -n sandbox get pod -l app=httpbin -o jsonpath='{range .items[0].spec.initContainers[*]}{.name}={.restartPolicy}{"\n"}{end}'
#   istio-init=
#   istio-proxy=Always
```

Os três Jobs fazem a mesma chamada ao httpbin assim que iniciam:

```bash
kubectl apply -f manifests/06b-jobs-sidecar.yaml; sleep 30
kubectl -n sandbox get jobs
#   job-classic        Running    0/1     ← nunca termina
#   job-classic-hold   Complete   1/1
#   job-native         Complete   1/1
for j in job-native job-classic job-classic-hold; do echo "$j: $(kubectl -n sandbox logs job/$j -c job | head -1)"; done
#   job-native: httpbin respondeu 200
#   job-classic: httpbin respondeu 000         ← o app rodou antes de o proxy estar pronto
#   job-classic-hold: httpbin respondeu 200
```

| Job | Sidecar | Início | Fim |
|---|---|---|---|
| `job-native` | native (padrão) | o proxy já está pronto | o kubelet encerra o proxy quando o app termina |
| `job-classic` | container comum (`sidecar.istio.io/nativeSidecar: "false"`) | corrida: a chamada falha | o proxy continua rodando, e o Job fica `Running` para sempre |
| `job-classic-hold` | container comum + `holdApplicationUntilProxyStarts` | o app espera o proxy | o app chama `POST localhost:15020/quitquitquit` |

> `holdApplicationUntilProxyStarts` e o `/quitquitquit` eram os contornos antes dos native sidecars, e você ainda vai encontrá-los em clusters antigos (Kubernetes < 1.29) e em charts de terceiros.

```bash
kubectl delete -f manifests/06a-proxy-tuning.yaml -f manifests/06b-jobs-sidecar.yaml
```

---

## Checklist de conclusão

- [ ] Sei a diferença entre rate limit local (por Envoy) e global (serviço central), e quando usar cada um
- [ ] Configurei um limite por usuário no ingress e entendi o fail open
- [ ] Vi um EnvoyFilter errado ser aceito pelo Kubernetes, rejeitado pelo Envoy (NACK) e travar pods novos
- [ ] Sei onde procurar `ACK ERROR` e por que EnvoyFilter é o último recurso
- [ ] Carreguei um WasmPlugin de uma imagem OCI
- [ ] Fiz um upgrade canário com revisões e tags, promovi e fiz rollback
- [ ] Ajustei recursos e concurrency do sidecar por anotação
- [ ] Entendi o que os native sidecars resolvem (ordem de início e Jobs)

## Limpeza

```bash
./reset.sh                    # recursos dos exercícios e rollback do canário
kubectl delete ns ratelimit   # serviço de rate limit e Redis
rm -rf bin                    # istioctl 1.31.3
```
