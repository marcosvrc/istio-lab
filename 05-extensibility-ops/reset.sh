#!/usr/bin/env bash
# Remove os recursos dos exercícios e desfaz o upgrade canário: os namespaces
# voltam para istio-injection=enabled no control plane original (1.31.0).
# Mantém o serviço de rate limit (namespace ratelimit) e o bin/istioctl.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
CANARY_REVISION="1-31-3"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }
log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "Recursos dos exercícios"
for f in manifests/0[1-46]*.yaml; do
  k delete -f "$f" --ignore-not-found
done

if k -n istio-system get deploy "istiod-$CANARY_REVISION" >/dev/null 2>&1; then
  log "Rollback do canário: namespaces de volta à revisão default"
  ISTIOCTL=istioctl
  [[ -x bin/istioctl ]] && ISTIOCTL=bin/istioctl
  for ns in $(k get ns -l istio.io/rev -o jsonpath='{.items[*].metadata.name}'); do
    k label ns "$ns" istio.io/rev- istio-injection=enabled --overwrite
    k -n "$ns" rollout restart deploy
  done
  for ns in bookinfo sandbox; do
    for d in $(k -n "$ns" get deploy -o name); do
      k -n "$ns" rollout status "$d" --timeout=180s
    done
  done
  for tag in prod-stable prod-canary; do
    "$ISTIOCTL" --context "$KUBE_CONTEXT" tag remove "$tag" -y 2>/dev/null || true
  done
  "$ISTIOCTL" --context "$KUBE_CONTEXT" uninstall --revision "$CANARY_REVISION" -y
fi
