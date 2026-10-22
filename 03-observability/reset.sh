#!/usr/bin/env bash
# Remove os recursos dos exercícios e restaura a Telemetry padrão do módulo 00.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

for f in manifests/[0-9]*.yaml; do
  k delete -f "$f" --ignore-not-found
done

# O exercício 5a substitui a Telemetry da mesh (mesh-default); restaura a original
k apply -f ../00-setup/manifests/telemetry.yaml
