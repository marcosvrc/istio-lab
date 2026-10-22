#!/usr/bin/env bash
# Pré-requisitos do módulo 02 (depende do 00-setup instalado).
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
CERT_MANAGER_VERSION="${CERT_MANAGER_VERSION:-v1.18.2}"
ISTIO_VERSION="$(istioctl version --remote=false 2>/dev/null | awk 'NR==1 {print $NF}')"
SAMPLES="https://raw.githubusercontent.com/istio/istio/release-${ISTIO_VERSION%.*}/samples"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k -n sandbox get deploy httpbin >/dev/null 2>&1 || { echo "Rode ../00-setup/install.sh primeiro" >&2; exit 1; }

log "Clientes: namespace client (com sidecar) e nomesh (sem sidecar)"
k apply -f manifests/base/clients.yaml
for ns in client nomesh; do
  k -n "$ns" apply -f "$SAMPLES/curl/curl.yaml"
done

log "httpbin no ingress (Host: httpbin.local)"
k apply -f manifests/base/httpbin-ingress.yaml

log "ext-authz (servidor de autorização externa de exemplo) no sandbox"
k -n sandbox apply -f "$SAMPLES/extauthz/ext-authz.yaml"

log "cert-manager $CERT_MANAGER_VERSION"
k apply -f "https://github.com/cert-manager/cert-manager/releases/download/${CERT_MANAGER_VERSION}/cert-manager.yaml"

log "Aguardando os deployments"
for ns in client nomesh sandbox cert-manager; do
  k -n "$ns" wait --for=condition=Available deployment --all --timeout=300s
done

log "Pronto. Siga os exercícios do README.md"
