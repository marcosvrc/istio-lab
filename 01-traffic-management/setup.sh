#!/usr/bin/env bash
# Pré-requisitos do módulo 01 (depende do 00-setup instalado).
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
GATEWAY_API_VERSION="${GATEWAY_API_VERSION:-v1.3.0}"
ISTIO_VERSION="$(istioctl version --remote=false 2>/dev/null | awk 'NR==1 {print $NF}')"
SAMPLES="https://raw.githubusercontent.com/istio/istio/release-${ISTIO_VERSION%.*}/samples"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k -n bookinfo get deploy productpage-v1 >/dev/null 2>&1 || { echo "Rode ../00-setup/install.sh primeiro" >&2; exit 1; }

log "CRDs da Kubernetes Gateway API ($GATEWAY_API_VERSION)"
if ! k get crd gateways.gateway.networking.k8s.io >/dev/null 2>&1; then
  k apply -f "https://github.com/kubernetes-sigs/gateway-api/releases/download/${GATEWAY_API_VERSION}/standard-install.yaml"
fi
k wait --for=condition=Established crd/gateways.gateway.networking.k8s.io crd/httproutes.gateway.networking.k8s.io

log "fortio (gerador de carga) e httpbin-v2 no namespace sandbox"
k -n sandbox apply -f "$SAMPLES/httpbin/sample-client/fortio-deploy.yaml"
k apply -f manifests/base/httpbin-v2.yaml
k -n sandbox wait --for=condition=Available deployment --all --timeout=300s

log "Pronto. Siga os exercícios do README.md"
