#!/usr/bin/env bash
# Pré-requisitos do módulo 06 (depende do 00-setup instalado).
# Parte 1 — progressive delivery: Argo Rollouts, o plugin do kubectl e a app
# de exemplo (namespace rollouts) com tráfego contínuo.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
ROLLOUTS_VERSION="${ROLLOUTS_VERSION:-v1.10.1}"
RELEASES="https://github.com/argoproj/argo-rollouts/releases/download/${ROLLOUTS_VERSION}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k -n istio-system get deploy prometheus >/dev/null 2>&1 || { echo "Rode ../00-setup/install.sh primeiro" >&2; exit 1; }

log "Argo Rollouts $ROLLOUTS_VERSION (namespace argo-rollouts)"
k create namespace argo-rollouts --dry-run=client -o yaml | k apply -f -
# server-side: as CRDs passam do limite de 256KB da anotação do apply client-side
k -n argo-rollouts apply --server-side --force-conflicts -f "$RELEASES/install.yaml"
k -n argo-rollouts rollout status deploy/argo-rollouts --timeout=180s

if [[ ! -x bin/kubectl-argo-rollouts ]] || ! bin/kubectl-argo-rollouts version 2>/dev/null | grep -q "$ROLLOUTS_VERSION"; then
  log "Plugin kubectl-argo-rollouts em bin/"
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m); [[ "$arch" == x86_64 ]] && arch=amd64; [[ "$arch" == aarch64 ]] && arch=arm64
  mkdir -p bin
  curl -sSfL -o bin/kubectl-argo-rollouts "$RELEASES/kubectl-argo-rollouts-${os}-${arch}"
  chmod +x bin/kubectl-argo-rollouts
fi

log "App rollouts-demo (blue), VirtualService/DestinationRule e gerador de carga"
k apply -f manifests/base/rollouts-app.yaml -f manifests/base/loadgen.yaml
k apply -f manifests/01-rollout-canary.yaml
k -n rollouts rollout status deploy/loadgen --timeout=180s
bin/kubectl-argo-rollouts --context "$KUBE_CONTEXT" -n rollouts status rollouts-demo --timeout 180s

log "Pronto. Siga os exercícios do README.md"
