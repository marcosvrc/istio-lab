# istio-lab

Lab de estudo do Istio rodando localmente no **Rancher Desktop** (Kubernetes 1.33, 10 CPU / 10 GB) com `istioctl` 1.31.

Cada módulo é um diretório independente com manifests + um `README.md` contendo: objetivo, comandos, como validar e como limpar.

## Pré-requisitos e cuidados com o Rancher Desktop

- **Desabilitar o Traefik** (Preferences → Kubernetes → desmarcar *Traefik*). Ele ocupa as portas 80/443 do LoadBalancer (klipper-lb) e conflita com o ingress gateway do Istio.
- Trocar o contexto: `kubectl config use-context rancher-desktop` (o contexto atual da máquina é `kind-gitops-lab`).
- O `LoadBalancer` do k3s expõe o gateway em `localhost` — dá para testar com `curl -H "Host: ..." http://localhost`.
- Cluster de nó único: features que dependem de topologia (locality LB, multi-cluster) precisam de um segundo cluster (`kind` já está instalado).

## Roteiro de módulos

Prioridade: ⭐ essencial · ◆ importante · ○ avançado/opcional

### 00 — Instalação e fundamentos ⭐
| Feature | O que estudar |
|---|---|
| `istioctl install` / Helm | Perfis (`minimal`, `default`, `demo`), `IstioOperator`, `istioctl x precheck` |
| Injeção de sidecar | Label `istio-injection=enabled`, injeção manual, `istioctl kube-inject` |
| App de exemplo | Bookinfo (multi-versão, ótimo p/ roteamento) + `httpbin` e `curl` como cliente |
| Addons | Kiali, Prometheus, Grafana, Jaeger (`samples/addons`) |
| Troubleshooting | `istioctl analyze`, `proxy-status`, `proxy-config (routes\|clusters\|listeners\|endpoints)`, `x pc log` |

### 01 — Gerenciamento de tráfego ⭐
| Feature | Recursos | Exercício |
|---|---|---|
| Ingress | `Gateway` (Istio) **e** Kubernetes Gateway API (`Gateway`/`HTTPRoute`) | Expor Bookinfo nas duas formas e comparar |
| Roteamento por versão | `VirtualService` + `DestinationRule` (subsets) | Fixar `reviews` em v1 |
| Canary / weighted | `weight` no VirtualService ou `HTTPRoute` | 90/10 → 50/50 → 100 |
| Roteamento por header/usuário | `match.headers` | Usuário `jason` vê v2 |
| Rewrite / redirect / CORS | `rewrite`, `redirect`, `corsPolicy` | — |
| Traffic mirroring | `mirror` + `mirrorPercentage` | Espelhar para v3 e ver logs |
| Timeouts e retries | `timeout`, `retries` (perTryTimeout, retryOn) | Combinar com fault injection |
| Fault injection | `fault.delay` / `fault.abort` | Testar resiliência da página |
| Circuit breaking | `connectionPool` + `outlierDetection` | Estressar `httpbin` com `fortio` |
| Load balancing | `ROUND_ROBIN`, `LEAST_REQUEST`, `consistentHash` (sticky session) | — |
| Egress | `ServiceEntry`, `outboundTrafficPolicy: REGISTRY_ONLY`, Egress Gateway | Bloquear saída e liberar só `httpbin.org` |
| Escopo de config | Recurso `Sidecar` | Reduzir config do Envoy (ver com `proxy-config`) |

### 02 — Segurança ⭐
| Feature | Recursos | Exercício |
|---|---|---|
| mTLS | `PeerAuthentication` PERMISSIVE → STRICT | Cliente sem sidecar falha em STRICT |
| Autorização L4/L7 | `AuthorizationPolicy` (ALLOW/DENY, principals, paths, methods) | Deny-all + liberar por service account |
| Autenticação de usuário final | `RequestAuthentication` (JWT) + AuthorizationPolicy com `requestPrincipals` | Token de exemplo do repo do Istio |
| Autorização externa | `action: CUSTOM` + ext-authz (OPA ou oauth2-proxy) | ◆ |
| TLS no ingress | Secret TLS no Gateway, **cert-manager** com CA self-signed | HTTPS em `localhost` |
| CA própria | Plug-in certs (`cacerts`), inspeção com `istioctl pc secret` | ○ |

### 03 — Observabilidade ⭐
| Feature | O que estudar |
|---|---|
| Kiali | Grafo de serviços, validação de config, visualizar canary/mTLS |
| Métricas | Métricas padrão (`istio_requests_total`...), PromQL básico, dashboards Grafana |
| Tracing | Propagação de headers, Jaeger ou Tempo via OpenTelemetry, sampling |
| Telemetry API | `Telemetry` para access logs, tags customizadas em métricas, sampling por namespace |

### 04 — Ambient mode ◆
| Feature | O que estudar |
|---|---|
| ztunnel (L4) | Instalar com `--set profile=ambient`, label `istio.io/dataplane-mode=ambient`, mTLS sem sidecar |
| Waypoint proxy (L7) | `istioctl waypoint apply`, políticas L7 só via waypoint |
| Comparativo | Mesmo exercício de tráfego/segurança em sidecar vs ambient; consumo de recursos |
| Migração | Namespace sidecar → ambient sem downtime |

### 05 — Extensibilidade e operação ◆
| Feature | O que estudar |
|---|---|
| Rate limiting | Local rate limit (via `EnvoyFilter`) e global (serviço de ratelimit + Redis) |
| `EnvoyFilter` | Patch de config do Envoy — entender por que é último recurso |
| `WasmPlugin` | Plugin Wasm simples (ex.: adicionar header) |
| Upgrade canário do control plane | `revision`, revision tags (`istioctl tag`), migrar namespaces entre revisões |
| Tuning | Recursos do sidecar, `holdApplicationUntilProxyStarts`, drenagem/graceful shutdown |

### 06 — Avançado ○
| Feature | Observação |
|---|---|
| Progressive delivery | Argo Rollouts ou Flagger usando métricas do Istio para canary automático |
| GitOps | Argo CD gerenciando os manifests deste repo (aproveita o `gitops-lab`) |
| Multi-cluster | Rancher Desktop + um cluster `kind` (multi-primary ou primary-remote, east-west gateway) — pesado |
| Locality load balancing / failover | Precisa de nós com labels de zona — viável com `kind` multi-nó |

## Ordem sugerida

`00 → 01 → 02 → 03` formam a base (≈ 80% do que se usa no dia a dia). Depois `04` (ambient é a direção atual do projeto), `05` e, por fim, `06`.

## Status

| Módulo | Status |
|---|---|
| [00-setup](00-setup/) | ✅ pronto |
| [01-traffic-management](01-traffic-management/) | ✅ pronto |
| [02-security](02-security/) | ✅ pronto |
| [03-observability](03-observability/) | ✅ pronto |
| [04-ambient](04-ambient/) | ✅ pronto |
| 05-extensibility-ops | planejado |
| 06-advanced | planejado |

Cada módulo tem `setup.sh` (pré-requisitos), `reset.sh` (volta ao estado inicial) e um `README.md` com os exercícios. Comece por `00-setup/install.sh`.

## Lab Console

Prefere uma interface visual? O [Lab Console](console/) é uma aplicação web local para aplicar os manifests, ajustar parâmetros, rodar os testes com gráficos e abrir Kiali, Grafana e Jaeger com um clique:

```bash
./console/start.sh   # http://127.0.0.1:7070
```
