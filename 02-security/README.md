# 02 — Segurança

**Objetivo:** criptografar e autenticar todo o tráfego entre serviços (mTLS), controlar quem pode chamar o quê (autorização), autenticar usuários finais (JWT) e proteger o ingress com TLS. É o zero-trust que o Istio entrega sem mudar as aplicações.

| # | Exercício | Recursos |
|---|---|---|
| 1 | mTLS PERMISSIVE → STRICT e identidade SPIFFE | `PeerAuthentication` |
| 2 | Deny-all, allow por identidade, DENY por header | `AuthorizationPolicy` |
| 3 | Menor privilégio no Bookinfo | `AuthorizationPolicy` com `principals` |
| 4 | JWT no ingress: validação, exigência e claims | `RequestAuthentication` + `AuthorizationPolicy` |
| 5 | HTTPS no ingress com cert-manager | `Certificate`, `Gateway` com `credentialName` |
| 6 | Autorização externa | `AuthorizationPolicy` `CUSTOM` + `extensionProviders` |

## Conceitos-chave

| Recurso | Pergunta que responde | Falha com |
|---|---|---|
| `PeerAuthentication` | O **workload** do outro lado é quem diz ser? (mTLS) | conexão recusada |
| `RequestAuthentication` | O **usuário** (JWT) é válido? | 401 |
| `AuthorizationPolicy` | Essa identidade pode fazer essa operação? | 403 `RBAC: access denied` |

- **Identidade** = service account do Kubernetes, codificada como SPIFFE ID no certificado do sidecar: `spiffe://cluster.local/ns/<ns>/sa/<sa>`. O istiod é a CA e rotaciona os certificados a cada 24h.
- **Ordem de avaliação das AuthorizationPolicy:** `CUSTOM` → `DENY` → `ALLOW`. Se existir **qualquer** ALLOW aplicável ao workload, o que não casar com nenhum ALLOW é negado.
- **Escopo:** namespace raiz (`istio-system`) = mesh toda; namespace = todos os workloads dele; `selector` = workloads específicos.

## Preparação

Requer o módulo 00. Rode `../01-traffic-management/reset.sh` se fez o módulo 01.

```bash
./setup.sh   # namespaces client (com sidecar) e nomesh (sem sidecar), ext-authz e cert-manager
```

Atalho para chamar de dentro de um namespace:

```bash
# uso: from <namespace> <args do curl>  → imprime o status HTTP
from() { kubectl -n "$1" exec deploy/curl -c curl -- curl -s -o /dev/null -m 5 -w '%{http_code}\n' "${@:2}"; }
```

> Políticas levam alguns segundos para chegar aos Envoys. Se um resultado não bater, espere ~5s e repita.

Para voltar ao estado inicial: `./reset.sh`.

---

## 1. mTLS

Por padrão a mesh está em **PERMISSIVE**: os sidecars já usam mTLS entre si automaticamente, mas também aceitam texto puro de quem não tem sidecar.

```bash
from client http://httpbin.sandbox:8000/get    # 200 (mTLS)
from nomesh http://httpbin.sandbox:8000/get    # 200 (texto puro!)
```

Ative STRICT no namespace `sandbox`:

```bash
kubectl apply -f manifests/01a-mtls-strict-sandbox.yaml
from client http://httpbin.sandbox:8000/get              # 200
from nomesh http://httpbin.sandbox:8000/get              # 000, exit 56 (conexão resetada)
from nomesh http://productpage.bookinfo:9080/productpage # 200 (bookinfo ainda é PERMISSIVE)
```

Agora na mesh inteira:

```bash
kubectl apply -f manifests/01b-mtls-strict-mesh.yaml
from nomesh http://productpage.bookinfo:9080/productpage # falha
curl -s -o /dev/null -w '%{http_code}\n' localhost/productpage   # 200: o ingress gateway faz parte da mesh
```

Veja a identidade que o servidor recebe (header injetado pelo Envoy):

```bash
kubectl -n client exec deploy/curl -c curl -- curl -s http://httpbin.sandbox:8000/headers | grep -A1 Forwarded-Client
# ...URI=spiffe://cluster.local/ns/client/sa/curl
```

E o certificado do workload:

```bash
istioctl pc secret deploy/httpbin -n sandbox -o json \
  | jq -r '.dynamicActiveSecrets[0].secret.tlsCertificate.certificateChain.inlineBytes' \
  | base64 -d | openssl x509 -noout -issuer -dates -ext subjectAltName
# URI:spiffe://cluster.local/ns/sandbox/sa/httpbin — validade de 24h
```

> **Migração em produção:** comece em PERMISSIVE, confirme no Kiali (cadeado nas arestas) ou na métrica `istio_requests_total{connection_security_policy="mutual_tls"}` que todo o tráfego já é mTLS, e só então vá para STRICT.

```bash
kubectl delete -f manifests/01a-mtls-strict-sandbox.yaml -f manifests/01b-mtls-strict-mesh.yaml
```

## 2. AuthorizationPolicy

### 2a. Deny-all

```bash
kubectl apply -f manifests/02a-deny-all-sandbox.yaml
kubectl -n client exec deploy/curl -c curl -- curl -s http://httpbin.sandbox:8000/get   # RBAC: access denied
```

### 2b. Liberar por identidade, método e path

```bash
kubectl apply -f manifests/02b-allow-client-httpbin.yaml
from client  http://httpbin.sandbox:8000/get          # 200
from client  http://httpbin.sandbox:8000/ip           # 403: path não liberado
from client  -X POST http://httpbin.sandbox:8000/get  # 403: método não liberado
from sandbox http://httpbin:8000/get                  # 403: outra service account
from nomesh  http://httpbin.sandbox:8000/get          # 403: sem identidade
```

> O `nomesh` recebe 403 e não erro de conexão, porque o mTLS está PERMISSIVE. Sem mTLS não há `principal`, e regras com `principals` nunca casam. Por isso **autorização por identidade pressupõe mTLS**.

### 2c. DENY tem precedência

```bash
kubectl apply -f manifests/02c-deny-header.yaml
from client -H 'x-block: true' http://httpbin.sandbox:8000/get   # 403
from client http://httpbin.sandbox:8000/get                      # 200
```

```bash
./reset.sh
```

## 3. Menor privilégio no Bookinfo

Cada serviço aceita só o chamador legítimo:

```
istio-ingressgateway → productpage → details
                                   → reviews → ratings
```

```bash
kubectl apply -f manifests/03-bookinfo-least-privilege.yaml
curl -s localhost/productpage | grep -oE 'reviews-v[0-9]'          # a página funciona, com estrelas

from client http://productpage.bookinfo:9080/productpage           # 403
from client http://reviews.bookinfo:9080/reviews/0                 # 403
# nem o productpage pode pular o reviews e chamar o ratings direto
# (a chamada sai do container do app, com a identidade do productpage):
kubectl -n bookinfo exec deploy/productpage-v1 -c productpage -- python -c "import urllib.request as u, urllib.error as e
try: print(u.urlopen('http://ratings:9080/ratings/0', timeout=5).status)
except e.HTTPError as x: print(x.code)"   # 403
```

Remova a regra do `ratings` e veja a página mostrar *"Ratings service is currently unavailable"*. Abra o Kiali e veja as arestas negadas em vermelho.

```bash
kubectl delete -f manifests/03-bookinfo-least-privilege.yaml
```

## 4. JWT no ingress

Tokens de teste do repositório do Istio:

```bash
B=https://raw.githubusercontent.com/istio/istio/release-1.31/security/tools/jwt/samples
TOKEN=$(curl -s $B/demo.jwt)
TOKEN_GROUP=$(curl -s $B/groups-scope.jwt)
echo "$TOKEN_GROUP" | cut -d. -f2 | base64 -d 2>/dev/null; echo   # claims: iss, sub, groups, scope
h() { curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: httpbin.local' "$@"; }
```

### 4a. Validação

```bash
kubectl apply -f manifests/04a-jwt-requestauthn.yaml
h http://localhost/headers                                         # 200: sem token ainda passa!
h -H 'Authorization: Bearer abc.def.ghi' http://localhost/headers  # 401: token inválido
h -H "Authorization: Bearer $TOKEN" http://localhost/headers       # 200
curl -s -H 'Host: httpbin.local' -H "Authorization: Bearer $TOKEN" http://localhost/headers | grep -A1 X-Jwt-Sub
```

> O `RequestAuthentication` só **valida** o token se ele vier. Requisição sem token é anônima, mas é permitida. Quem exige o token é a AuthorizationPolicy.

### 4b. Exigir token

```bash
kubectl apply -f manifests/04b-jwt-require.yaml
h http://localhost/headers                                    # 403
h -H "Authorization: Bearer $TOKEN" http://localhost/headers  # 200
curl -s -o /dev/null -w '%{http_code}\n' localhost/productpage   # 200: só o httpbin.local exige token
```

> A política usa `DENY` + `notRequestPrincipals: ["*"]` em vez de `ALLOW` + `requestPrincipals`. Um ALLOW no gateway passaria a negar tudo que não casasse, incluindo o Bookinfo. Os `ports` explícitos evitam que o DENY, que usa atributos HTTP, bloqueie as portas TCP do gateway (o `istioctl validate` avisa isso).

### 4c. Autorização por claim

```bash
kubectl apply -f manifests/04c-jwt-claims.yaml
h -H "Authorization: Bearer $TOKEN"       http://localhost/status/200   # 403: sem group1
h -H "Authorization: Bearer $TOKEN_GROUP" http://localhost/status/200   # 200
h -H "Authorization: Bearer $TOKEN"       http://localhost/headers      # 200: regra só vale para /status/*
```

```bash
kubectl delete -f manifests/04c-jwt-claims.yaml -f manifests/04b-jwt-require.yaml -f manifests/04a-jwt-requestauthn.yaml
```

## 5. HTTPS no ingress com cert-manager

O cert-manager cria uma CA do lab e emite o certificado de `httpbin.local`. O Gateway o usa via `credentialName`, e o cert-manager o renova sozinho.

```bash
kubectl apply -f manifests/05-ingress-tls.yaml
kubectl -n istio-system wait --for=condition=Ready certificate/httpbin-local
kubectl -n cert-manager get secret lab-ca -o jsonpath='{.data.ca\.crt}' | base64 -d > /tmp/lab-ca.crt

curl -sI -H 'Host: httpbin.local' http://localhost/get | head -3      # 301 → https
curl -s --cacert /tmp/lab-ca.crt --resolve httpbin.local:443:127.0.0.1 https://httpbin.local/get   # 200
curl -s --resolve httpbin.local:443:127.0.0.1 https://httpbin.local/get   # exit 60: CA desconhecida

openssl s_client -connect 127.0.0.1:443 -servername httpbin.local </dev/null 2>/dev/null \
  | openssl x509 -noout -issuer -ext subjectAltName                  # issuer=CN=istio-lab-ca
istioctl pc secret deploy/istio-ingressgateway -n istio-system | grep httpbin
```

> Para o navegador: adicione `127.0.0.1 httpbin.local` ao `/etc/hosts` e importe `/tmp/lab-ca.crt` no Keychain como confiável.
>
> **Desafio:** troque `mode: SIMPLE` por `MUTUAL` (exige certificado do cliente). Emita um certificado de cliente com outro `Certificate` e use `curl --cert/--key`.

```bash
./reset.sh
```

## 6. Autorização externa (CUSTOM)

Para regras que não cabem na AuthorizationPolicy (consultar um banco, OPA/Rego, OAuth2...), o Envoy pode perguntar a um serviço externo a cada requisição. O servidor é registrado como provider em `meshConfig.extensionProviders`. Isso já está no `../00-setup/istio-operator.yaml`:

```bash
kubectl -n istio-system get cm istio -o jsonpath='{.data.mesh}' | grep -A5 sample-ext-authz
```

```bash
kubectl apply -f manifests/06-extauthz.yaml
from client -H 'x-ext-authz: allow' http://httpbin.sandbox:8000/headers   # 200
from client -H 'x-ext-authz: deny'  http://httpbin.sandbox:8000/headers   # 403
from client http://httpbin.sandbox:8000/get                               # 200: fora da regra
kubectl -n sandbox logs deploy/ext-authz --tail=3                          # as decisões do servidor
```

Na vida real o provider seria OPA, oauth2-proxy ou Authorino. Também existe `envoyExtAuthzGrpc` (o sample escuta gRPC na porta 9000).

```bash
kubectl delete -f manifests/06-extauthz.yaml
```

---

## Checklist de conclusão

- [ ] Sei a diferença entre PeerAuthentication, RequestAuthentication e AuthorizationPolicy
- [ ] Migrei de PERMISSIVE para STRICT e vi um cliente sem sidecar ser recusado
- [ ] Sei ler um SPIFFE ID e de onde ele vem (service account)
- [ ] Montei deny-all + allow por principal, método e path
- [ ] Entendi por que no gateway se usa DENY + `notRequestPrincipals`
- [ ] Exigi JWT e autorizei por claim
- [ ] Servi HTTPS com um certificado do cert-manager
- [ ] Deleguei a autorização a um serviço externo

## Limpeza

```bash
./reset.sh
kubectl delete ns client nomesh
kubectl -n sandbox delete -f https://raw.githubusercontent.com/istio/istio/release-1.31/samples/extauthz/ext-authz.yaml
kubectl delete -f https://github.com/cert-manager/cert-manager/releases/download/v1.18.2/cert-manager.yaml
```
