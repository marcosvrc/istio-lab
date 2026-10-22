#!/usr/bin/env bash
# Remove os recursos dos exercícios e volta o lab ao estado do módulo 00.
# Não remove o que o setup.sh instalou (CRDs, fortio, httpbin-v2) nem o egress gateway.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

for f in manifests/[0-9]*.yaml; do
  case "$f" in *operator*) continue ;; esac
  k delete -f "$f" --ignore-not-found
done

# Exercício 9 altera a DestinationRule do reviews; restaura a original
k apply -f ../00-setup/manifests/destination-rules.yaml
# Exercício 9 escala o reviews-v1
k -n bookinfo scale deploy reviews-v1 --replicas=1
