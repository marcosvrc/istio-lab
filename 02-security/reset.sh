#!/usr/bin/env bash
# Remove as políticas dos exercícios e volta ao estado pós-setup.
# Mantém clientes, ext-authz, cert-manager e o provider do ext-authz no istiod.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

for f in manifests/[0-9]*.yaml; do
  case "$f" in *operator*) continue ;; esac
  k delete -f "$f" --ignore-not-found
done

# O exercício 5 substitui o Gateway do httpbin; restaura a versão HTTP
k apply -f manifests/base/httpbin-ingress.yaml
