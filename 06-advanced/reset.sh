#!/usr/bin/env bash
# Volta ao estado pós-setup: Rollout na versão blue com a estratégia do
# exercício 1, VirtualService e DestinationRule originais, sem análises.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k -n rollouts delete rollout rollouts-demo --ignore-not-found --wait
k delete -f manifests/02-analysis-templates.yaml --ignore-not-found
k -n rollouts delete analysisrun --all --ignore-not-found
# o Rollouts edita os pesos do VirtualService e os labels da DestinationRule
k apply -f manifests/base/rollouts-app.yaml -f manifests/base/loadgen.yaml
k apply -f manifests/01-rollout-canary.yaml
bin/kubectl-argo-rollouts --context "$KUBE_CONTEXT" -n rollouts status rollouts-demo --timeout 180s
