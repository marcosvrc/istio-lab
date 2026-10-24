# 06 — Avançado

**Objetivo:** usar a mesh como base de práticas de entrega e operação em escala. Este módulo é dividido em partes independentes.

| Parte | Tema | Status |
|---|---|---|
| 1 | Progressive delivery com Argo Rollouts | ✅ pronto (abaixo) |
| 2 | GitOps com Argo CD gerenciando os manifests deste repo | planejado |
| 3 | Locality load balancing e failover (`kind` multi-nó com zonas) | planejado |
| 4 | Multi-cluster (Rancher Desktop + `kind`, east-west gateway) | planejado |

---

# Parte 1 — Progressive delivery com Argo Rollouts

**Objetivo:** automatizar o canary que o módulo 01 fazia à mão (editando pesos no VirtualService). Um controller avança os pesos em passos, consulta as métricas do Istio no Prometheus e **desfaz sozinho** uma versão ruim.

| # | Exercício | Recursos |
|---|---|---|
| 1 | Canary em passos, com pausa manual | `Rollout`, `trafficRouting.istio` |
| 2 | Análise automática: rollback por erro e por latência | `AnalysisTemplate` (Prometheus) |
| 3 | Preview por header antes de qualquer usuário | `setHeaderRoute`, `managedRoutes` |

## Conceitos-chave

- **Rollout** substitui o `Deployment`. Mudou o template (a imagem, por exemplo)? Ele cria um ReplicaSet *canary* ao lado do *stable* e segue os `steps`.
- **Com Istio, o peso é exato.** Sem mesh, "20%" significa "20% dos pods", e com 2 réplicas isso nem é possível. Aqui o Rollouts edita os pesos da rota `primary` do VirtualService, e a proporção independe do número de réplicas.
- **Subsets gerenciados**: os subsets `stable` e `canary` da DestinationRule ganham o label `rollouts-pod-template-hash` de cada versão. Não edite esses campos durante um rollout.
- **Análise**: uma `AnalysisTemplate` é uma query com uma condição de sucesso. Rodando em segundo plano, ela aborta o rollout quando falha mais que `failureLimit` vezes. Abortar = 100% de volta ao stable, status `Degraded`.
- As métricas são as do módulo 03, na **visão do cliente** (`reporter="source"`), que inclui os erros gerados pelo próprio Envoy.

## Preparação

Requer o módulo 00 (Prometheus incluído). Rode o `reset.sh` dos módulos anteriores.

```bash
./setup.sh
```

O script instala o Argo Rollouts v1.10.1 (namespace `argo-rollouts`) e baixa o plugin `kubectl-argo-rollouts` para `bin/` (fora do git). Também sobe, no namespace `rollouts` (com sidecar):
- o `Rollout` rollouts-demo na versão `blue`;
- o Service, a DestinationRule e o VirtualService (`manifests/base/rollouts-app.yaml`);
- um gerador de carga (~10 req/s), que alimenta as métricas.

> As CRDs do Argo Rollouts são grandes demais para o `kubectl apply` comum (limite de 256KB na anotação `last-applied-configuration`). Por isso o setup usa `--server-side`.

A imagem `argoproj/rollouts-demo` tem uma tag por cor (`blue`, `yellow`, `green`, `purple`, `orange`, `red`) e variantes com defeito: `bad-<cor>` responde **500 na maioria das requisições**, e `slow-<cor>` demora **2s**.

Atalhos:

```bash
alias rollouts='bin/kubectl-argo-rollouts -n rollouts'
# distribuição de 50 respostas, de dentro da mesh
dist() { kubectl -n sandbox exec deploy/curl -c curl -- sh -c "for i in \$(seq 50); do curl -s $1 http://rollouts-demo.rollouts:8080/color; echo; done" | sort | uniq -c; }
# pesos atuais do VirtualService
vsw() { kubectl -n rollouts get vs rollouts-demo -o jsonpath='{range .spec.http[*]}{.name}: {range .route[*]}{.destination.subset}={.weight} {end}{"\n"}{end}'; }
```

Para ver a UI (quadradinhos coloridos que mudam conforme a versão que responde), adicione `127.0.0.1 rollouts.local` ao `/etc/hosts` e abra http://rollouts.local. O plugin também tem um dashboard: `bin/kubectl-argo-rollouts dashboard` → http://localhost:3100.

Para voltar ao estado inicial: `./reset.sh`.

> **Recursos do lab.** O gerador de carga e o Prometheus somam CPU e memória o tempo todo. Fora deste módulo, pause o gerador: `kubectl -n rollouts scale deploy loadgen --replicas=0` (o `reset.sh` o religa). Se o Prometheus começar a reiniciar com `OOMKilled` (o nó fica sem memória depois de muitas recriações de pods, porque cada pod novo gera séries novas), recrie o pod dele: `kubectl -n istio-system delete pod -l app.kubernetes.io/name=prometheus`. Os dados ficam num `emptyDir`, então só se perde o histórico. Com o Prometheus fora do ar, as análises ficam sem dados.

---

## 1. Canary em passos

```bash
rollouts get rollout rollouts-demo          # Healthy, stable = blue
rollouts set image rollouts-demo rollouts-demo=docker.io/argoproj/rollouts-demo:yellow
sleep 25
rollouts get rollout rollouts-demo
#   Status:   ॥ Paused   (CanaryPauseStep)
#   Step:     1/6   SetWeight: 20   ActualWeight: 20
#   Images:   ...:blue (stable)   ...:yellow (canary)
vsw                                         # primary: stable=80 canary=20
dist                                        # ~40 "blue" / ~10 "yellow"
```

O passo 2 é uma `pause: {}` sem duração: o rollout espera alguém decidir. Valide a versão nova (UI, Kiali, logs) e promova:

```bash
rollouts promote rollouts-demo
#   t≈10s  stable=50 canary=50
#   t≈40s  stable=20 canary=80
#   t≈75s  stable=100 canary=0   Healthy: yellow agora é o stable
kubectl -n rollouts get dr rollouts-demo -o jsonpath='{.spec.subsets}'
#   os dois subsets apontam para o hash da versão nova; os pods da blue são removidos
```

Para desistir no meio: `rollouts abort rollouts-demo` (volta 100% para o stable). Para seguir com uma correção, troque a imagem de novo.

## 2. Análise automática

As duas `AnalysisTemplate` consultam o Prometheus da mesh a cada 20s:

| Template | Query | Sucesso |
|---|---|---|
| `success-rate` | `rate` de não-5xx / `rate` total, com `reporter="source"` | `>= 0.95` |
| `latency-p90` | `histogram_quantile(0.9, ...)` de `istio_request_duration_milliseconds` | `< 500` ms |

```bash
kubectl apply -f manifests/02-analysis-templates.yaml -f manifests/02-rollout-analysis.yaml
```

O `02-rollout-analysis.yaml` é o mesmo Rollout, sem pausa manual e com as duas análises em segundo plano desde o primeiro passo (20% por 60s → 50% por 60s → 100%). Como a imagem não mudou, aplicar não inicia um rollout.

**Uma versão que dá erro:**

```bash
rollouts set image rollouts-demo rollouts-demo=docker.io/argoproj/rollouts-demo:bad-red
#   t≈15s  stable=80 canary=20   Paused
#   t≈75s  stable=100 canary=0   Degraded, abort=true
kubectl -n rollouts get analysisrun                         # ...-3   Failed
kubectl -n rollouts get analysisrun -o json | jq -r '.items[-1].status.metricResults[] | "\(.name): " + ([.measurements[] | "\(.value)/\(.phase)"] | join(" "))'
#   success-rate: [1]/Successful [1]/Successful [0.83]/Failed [0.83]/Failed
#   latency-p90:  [9.4]/Successful [4.6]/Successful ...
kubectl -n rollouts get rollout rollouts-demo -o jsonpath='{.status.message}'
#   RolloutAborted: ... Metric "success-rate" assessed Failed due to failed (2) > failureLimit (1)
```

20% do tráfego com 500 dá ~0.83 de sucesso no serviço inteiro. As duas primeiras medições ainda dão 1, porque a janela de 30s do `rate` atrasa a detecção. Durante esse tempo (~1 min), um em cada cinco usuários recebeu erro.

> **O desenho dos passos é a sua margem de risco.** Primeiro passo menor (5%) = menos usuários afetados. `interval` e janela do `rate` menores = detecção mais rápida, mas mais ruído. Sem tráfego, a taxa vira 0/0 = `NaN`, e nenhuma comparação com `NaN` é verdadeira. Com `successCondition` **e** `failureCondition` declaradas, a medição fica `Inconclusive` e o rollout pausa (`pauseConditions: InconclusiveAnalysisRun`) esperando alguém promover ou abortar. Só com a `successCondition`, a falta de dados contaria como **falha**. Teste: `kubectl -n rollouts scale deploy loadgen --replicas=0` e troque a imagem.

**Uma versão lenta:**

```bash
rollouts set image rollouts-demo rollouts-demo=docker.io/argoproj/rollouts-demo:slow-yellow
#   t≈90s  stable=100 canary=0   Degraded
#   ... Metric "latency-p90" assessed Failed due to failed (2) > failureLimit (1)
```

Não houve nenhum erro HTTP, mas com 20% das respostas levando 2s o p90 passa de 500ms.

**Uma versão boa** chega a 100% sem ninguém intervir:

```bash
rollouts set image rollouts-demo rollouts-demo=docker.io/argoproj/rollouts-demo:green
#   t≈30s   stable=80 canary=20
#   t≈110s  stable=50 canary=50
#   t≈150s  stable=100 canary=0   Healthy
kubectl -n rollouts get analysisrun --sort-by=.metadata.creationTimestamp
#   ...-3  Failed  /  ...-4  Failed  /  ...-5  Successful
```

## 3. Preview por header

Antes de qualquer usuário, a equipe testa a versão nova em produção, com um header:

```bash
kubectl apply -f manifests/03-rollout-header-preview.yaml
rollouts set image rollouts-demo rollouts-demo=docker.io/argoproj/rollouts-demo:purple
sleep 30
kubectl -n rollouts get vs rollouts-demo -o json | jq -c '.spec.http[] | {name, match, route: [.route[] | "\(.destination.subset)=\(.weight // 100)"]}'
#   {"name":"preview","match":[{"headers":{"x-canary":{"exact":"true"}}}],"route":["canary=100"]}
#   {"name":"primary","match":null,"route":["stable=100","canary=0"]}
dist                       # 50 "green": usuários continuam no stable
dist "-H x-canary:true"    # 50 "purple"
```

O `setCanaryScale` sobe um pod da versão nova sem mandar tráfego de usuários para ele, e o `setHeaderRoute` cria a rota `preview` acima da `primary` (ela precisa estar declarada em `managedRoutes`). Ao promover, o rollout segue os pesos normalmente e, no fim, **remove** a rota `preview`:

```bash
rollouts promote rollouts-demo; sleep 50
vsw                        # primary: stable=100 canary=0   (sem a rota preview)
```

> No ingress vale o mesmo: o VirtualService também atende `rollouts.local`. Com uma extensão de navegador que adiciona headers, você vê a versão nova na UI enquanto os outros usuários continuam na anterior.

---

## Checklist da parte 1

- [ ] Fiz um canary em passos com pausa manual e promovi
- [ ] Entendi por que, com Istio, o peso independe do número de réplicas
- [ ] Escrevi AnalysisTemplates com as métricas do Istio (taxa de sucesso e p90)
- [ ] Vi o rollback automático de uma versão com erro e de uma versão lenta
- [ ] Sei ajustar passos, intervalos e `failureLimit` ao risco aceitável
- [ ] Testei uma versão nova só com um header antes de liberar para usuários

## Limpeza

```bash
./reset.sh                                   # volta o Rollout para blue, sem análises
kubectl delete ns rollouts
kubectl -n argo-rollouts delete -f https://github.com/argoproj/argo-rollouts/releases/download/v1.10.1/install.yaml
kubectl delete ns argo-rollouts
rm -rf bin
```
