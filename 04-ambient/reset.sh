#!/usr/bin/env bash
# Remove os recursos dos exercícios e volta o Bookinfo para sidecar.
# Mantém o modo ambient instalado (istio-cni, ztunnel) e as apps do namespace ambient.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

for f in manifests/0[1-6]*.yaml; do
  k delete -f "$f" --ignore-not-found
done
k label ns ambient istio.io/use-waypoint- 2>/dev/null || true
k -n ambient label svc httpbin istio.io/ingress-use-waypoint- 2>/dev/null || true

if [[ "$(k get ns bookinfo -o jsonpath='{.metadata.labels.istio\.io/dataplane-mode}')" == "ambient" ]]; then
  ./rollback-bookinfo.sh
fi
