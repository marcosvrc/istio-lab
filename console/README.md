# istio-lab console

Interface web local para fazer os exercícios do lab de forma visual: aplicar e remover manifests com um clique, ajustar parâmetros (pesos, delays, timeouts...) sem editar YAML, rodar os testes e ver o resultado em gráfico, e acompanhar **cada comando** que o console executou no cluster.

```
┌─ istio-lab console ────────── contexto rancher-desktop · Istio 1.31 · istio-system ok ─ Kiali↗ Grafana↗ … ┐
│ 00 · Instalação         │ 01-traffic-management · Gerenciamento de tráfego                                  │
│ 01 · Tráfego            │ 3. Canary por peso                                [Setup] [Reset] [↻]             │
│   ● 1. Versão           │ ┌ manifests/03-reviews-canary.yaml ─────── aplicado ─ [Ver YAML] [Aplicar] [Remover] │
│   ● 2. Header           │ │ Peso v1 [50]   Peso v3 [50]                                                    │
│   ● 3. Canary  ◀        │ └──────────────────────────────────────────────────────────────────────────────── │
│   ○ 4. Ingress          │ ┌ Distribuição ──────────────────────────────────────────── [Rodar de novo] ─────┐ │
│ 02 · Segurança          │ │ reviews-v3  ███████████████████████▌        54 · 54%                            │ │
│                         │ │ reviews-v1  ████████████████████            46 · 46%                            │ │
└─────────────────────────┴──────────────────────────────────────────────────────────── [Comandos 12] ────────┘
```

## Como rodar

Requer Go 1.22+ e o lab instalado (`00-setup/install.sh`).

```bash
./console/start.sh
# istio-lab console em http://127.0.0.1:7070  (contexto "rancher-desktop", 5 módulos)
```

Abra http://127.0.0.1:7070. Opções:

```bash
./console/start.sh -addr 127.0.0.1:8000 -context outro-cluster
```

O console escuta só em `127.0.0.1` e executa apenas o que está nos catálogos do repositório. Ele usa o `kubectl` e o `istioctl` da sua máquina, com o contexto informado.

## O que a tela oferece

| Área | O que faz |
|---|---|
| Barra superior | Contexto, versão do Istio, saúde do `istio-system` e botões que abrem **Kiali, Grafana, Jaeger, Prometheus e fortio** (o console cria e encerra o port-forward) |
| Barra lateral | Módulos e exercícios. A bolinha mostra o estado dos manifests: verde = aplicado, amarela = parcial ou com outra config, cinza = não aplicado |
| Manifests | Ver o YAML (com os parâmetros aplicados), **Aplicar** e **Remover**. Campos editados ficam destacados. O estado é comparado com o cluster via `kubectl diff` |
| Comandos | Ações do exercício (`istioctl proxy-config`, escalar deployments, instalar o egress gateway...), com a saída na tela |
| Testes | Rodam os mesmos comandos do README N vezes (localmente ou de dentro de um pod da mesh) e mostram a distribuição dos resultados e se bateu com o esperado. "script executado" mostra o comando exato |
| Comandos executados | Histórico de tudo que o console rodou: `kubectl apply`, testes, port-forwards. Bom para aprender o equivalente em linha de comando |
| Setup / Reset | Rodam o `setup.sh` / `reset.sh` do módulo |

> A config leva alguns segundos para chegar aos Envoys. Depois de aplicar, espere ~5s antes de testar. Se um resultado não bater, rode o teste de novo.

## Módulos com catálogo

| Módulo | Exercícios no console |
|---|---|
| 00-setup | saúde da instalação, comandos de diagnóstico |
| 01-traffic-management | os 12 exercícios |
| 02-security | os 7 exercícios, incluindo a troca de CA sem downtime |
| 03-observability | os 6 exercícios: métricas como gráfico (cliente × servidor), SLIs, access logs e traces |
| 04-ambient | os 7 exercícios, incluindo a migração do Bookinfo passo a passo |
| 05-extensibility-ops | os 6 exercícios, incluindo o upgrade canário completo (instalar, promover e fazer rollback) |
| 06-advanced | parte 1: canary com Argo Rollouts, análise automática e preview por header |

No módulo 03, os testes usam as funções de `03-observability/helpers.sh` (`promql`, `traces`...), que exigem `jq`. Resultados do Prometheus dependem do intervalo de coleta: depois de gerar tráfego, espere ~20s.

## Como adicionar exercícios (`<módulo>/console.yaml`)

O console é genérico: tudo o que ele mostra vem do arquivo `console.yaml` de cada módulo. Ele é recarregado ao reiniciar o console ou com `curl -XPOST localhost:7070/api/catalog/reload`.

```yaml
title: Gerenciamento de tráfego
summary: Texto curto do módulo.
setup: setup.sh            # opcional: botão "Setup do módulo"
reset: reset.sh            # opcional: botão "Reset do módulo"
vars:                      # opcional: variáveis calculadas uma vez (comando local) e
  TOKEN: curl -s https://… # disponíveis como $TOKEN nos testes

exercises:
  - title: 3. Canary por peso
    summary: |             # aceita `código` e **negrito**
      Ajuste os pesos…
    manifests:
      - path: manifests/03-reviews-canary.yaml   # relativo ao módulo
        note: texto opcional (ex.: pré-requisito)
        params:                                  # opcional: campos editáveis
          - name: v1
            label: Peso v1
            type: number                         # number | text
            doc: 0                               # documento no arquivo multi-doc (padrão 0)
            path: spec.http.0.route.0.weight     # chaves e índices separados por ponto
            hint: texto de ajuda
    actions:
      - label: Escalar reviews-v1
        run: kubectl -n bookinfo scale deploy reviews-v1 --replicas=3
    tests:
      - title: Distribuição
        chart: true                  # mostra barras
        cases:
          - label: 100 requisições
            run: |-                  # uma execução = uma amostra (1ª linha da saída)
              curl -s http://localhost/productpage | grep -oE 'reviews-v[0-9]' | head -1
            repeat: 100
            in: sandbox              # opcional: roda dentro de deploy/curl desse namespace
            before: |-               # opcional: roda uma vez antes do loop (ex.: login)
              J=$(mktemp); curl -s -c "$J" …
            expect: "200"            # opcional: regex que todas as amostras devem casar
            tally: '^Code (\d+) : (\d+)'  # opcional: saída já agregada (rótulo, quantidade)
```

Regras práticas:
- Em comandos de uma linha com `: ` (ex.: `-H 'Host: x'`), use `run: |-`. Senão o YAML quebra.
- `kubectl` e `istioctl` dentro de `run` já usam o contexto do console.
- Saídas com exit code ≠ 0 viram `… (exit N)`, por exemplo `000 (exit 56)` quando a conexão é recusada.

## Estrutura

```
console/
  main.go        servidor HTTP e API (/api/...)
  catalog.go     leitura dos console.yaml
  yamlutil.go    parâmetros aplicados no YAML (preserva comentários)
  exec.go        execução de kubectl/istioctl/sh e o log de comandos
  tests.go       execução dos testes e agregação dos resultados
  dashboards.go  port-forwards para Kiali, Grafana, Jaeger, Prometheus e fortio
  web/           interface (HTML/CSS/JS puros, embutidos no binário)
  vendor/        dependência (gopkg.in/yaml.v3), para compilar sem baixar nada
```
