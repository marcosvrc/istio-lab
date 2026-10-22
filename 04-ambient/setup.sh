#!/usr/bin/env bash
# Habilita o modo ambient e cria as apps do módulo 04 (depende do 00-setup).
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
GATEWAY_API_VERSION="${GATEWAY_API_VERSION:-v1.3.0}"
ISTIO_VERSION="$(istioctl version --remote=false 2>/dev/null | awk 'NR==1 {print $NF}')"
SAMPLES="https://raw.githubusercontent.com/istio/istio/release-${ISTIO_VERSION%.*}/samples"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k -n bookinfo get deploy productpage-v1 >/dev/null 2>&1 || { echo "Rode ../00-setup/install.sh primeiro" >&2; exit 1; }

# Rancher Desktop + dockerd: o istio-cni falha com
#   "path /var/run/netns is mounted on /run but it is not a shared or slave mount"
# Corrige na VM (não sobrevive a um restart; veja o README para tornar permanente).
if [[ "$KUBE_CONTEXT" == "rancher-desktop" ]] && command -v rdctl >/dev/null; then
  log "Rancher Desktop: tornando /run um mount compartilhado na VM"
  rdctl shell sudo mount --make-shared /run
fi

log "CRDs da Kubernetes Gateway API (waypoints são Gateways)"
if ! k get crd gateways.gateway.networking.k8s.io >/dev/null 2>&1; then
  k apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml"
fi

log "Control plane com perfil ambient (istio-cni + ztunnel)"
overlays=(-f ../00-setup/istio-operator.yaml)
if k -n istio-system get deploy istio-egressgateway >/dev/null 2>&1; then
  overlays+=(-f ../01-traffic-management/manifests/12-egress-gateway-operator.yaml)  # preserva o egress gateway
fi
overlays+=(-f ambient-operator.yaml)
istioctl --context "$KUBE_CONTEXT" install -y "${overlays[@]}"
k -n istio-system rollout status ds/istio-cni-node --timeout=180s
k -n istio-system rollout status ds/ztunnel --timeout=180s

log "Apps: httpbin, httpbin-v2 e curl (ambient); curl (outside, fora da mesh)"
k apply -f manifests/base/namespaces.yaml
k -n ambient apply -f "$SAMPLES/httpbin/httpbin.yaml" -f "$SAMPLES/curl/curl.yaml"
k apply -f manifests/base/httpbin-v2.yaml
k -n outside apply -f "$SAMPLES/curl/curl.yaml"
for ns in ambient outside; do
  k -n "$ns" wait --for=condition=Available deployment --all --timeout=300s
done

log "Pronto. Siga os exercícios do README.md"
