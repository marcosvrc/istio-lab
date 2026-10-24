#!/usr/bin/env bash
# Recria os workloads da mesh para receberem o certificado e o trust bundle
# atuais do istiod: deployments dos namespaces com sidecar, gateways e o
# ztunnel (que guarda os certificados dos pods ambient).
# Uso: ./restart-mesh.sh [namespace...]   (padrão: todos os da mesh)
set -euo pipefail

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

if [[ $# -gt 0 ]]; then
  namespaces=("$@")
else
  read -ra namespaces <<<"$(k get ns -l istio-injection=enabled -o jsonpath='{.items[*].metadata.name}') $(k get ns -l istio.io/rev -o jsonpath='{.items[*].metadata.name}')"
  k -n istio-system rollout restart deploy -l 'istio in (ingressgateway,egressgateway)'
  if k -n istio-system get ds ztunnel >/dev/null 2>&1; then
    k -n istio-system rollout restart ds/ztunnel
  fi
fi

for ns in "${namespaces[@]}"; do
  k -n "$ns" rollout restart deploy
done
for ns in "${namespaces[@]}"; do
  for d in $(k -n "$ns" get deploy -o name); do
    k -n "$ns" rollout status "$d" --timeout=180s
  done
done
if [[ $# -eq 0 ]]; then
  k -n istio-system rollout status deploy -l 'istio in (ingressgateway,egressgateway)' --timeout=180s 2>/dev/null || true
  k -n istio-system rollout status ds/ztunnel --timeout=180s 2>/dev/null || true
fi
