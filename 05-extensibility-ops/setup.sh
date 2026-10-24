#!/usr/bin/env bash
# Pré-requisitos do módulo 05 (depende do 00-setup instalado).
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
CANARY_VERSION="${CANARY_VERSION:-1.31.3}"   # versão do control plane canário (exercício 5)
ISTIO_VERSION="$(istioctl version --remote=false 2>/dev/null | awk 'NR==1 {print $NF}')"
SAMPLES="https://raw.githubusercontent.com/istio/istio/release-${ISTIO_VERSION%.*}/samples"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k -n sandbox get deploy httpbin >/dev/null 2>&1 || { echo "Rode ../00-setup/install.sh primeiro" >&2; exit 1; }

# Com o istio-cni instalado (módulo 04), pods que sobem antes do CNI ficar
# pronto (ex.: depois de reiniciar a VM) falham no init container
# istio-validation e não se recuperam sozinhos: é preciso recriá-los.
broken=$(k get pods -A -o json | jq -r '.items[] | select(any(.status.initContainerStatuses[]?;
  .name == "istio-validation" and ((.state.waiting.reason // "") == "CrashLoopBackOff" or (.state.terminated.exitCode // 0) != 0)))
  | "\(.metadata.namespace)/\(.metadata.name)"')
if [[ -n "$broken" ]]; then
  log "Recriando pods que subiram antes do istio-cni"
  for p in $broken; do k -n "${p%%/*}" delete pod "${p#*/}" --wait=false; done
fi

log "Serviço de rate limit global (envoyproxy/ratelimit + Redis) no namespace ratelimit"
k apply -f manifests/base/ratelimit-config.yaml
k -n ratelimit apply -f "$SAMPLES/ratelimit/rate-limit-service.yaml"

log "httpbin no ingress (Host: httpbin.local)"
k apply -f manifests/base/httpbin-ingress.yaml

if [[ ! -x bin/istioctl ]] || ! bin/istioctl version --remote=false 2>/dev/null | grep -q "$CANARY_VERSION"; then
  log "istioctl $CANARY_VERSION em bin/ (control plane canário)"
  os=$(uname -s | tr '[:upper:]' '[:lower:]'); [[ "$os" == darwin ]] && os=osx
  arch=$(uname -m); [[ "$arch" == x86_64 ]] && arch=amd64; [[ "$arch" == aarch64 ]] && arch=arm64
  mkdir -p bin
  curl -sSfL "https://github.com/istio/istio/releases/download/${CANARY_VERSION}/istioctl-${CANARY_VERSION}-${os}-${arch}.tar.gz" | tar -xz -C bin
fi
bin/istioctl version --remote=false

log "Aguardando os deployments"
k -n ratelimit wait --for=condition=Available deployment --all --timeout=300s
k -n bookinfo wait --for=condition=Available deployment --all --timeout=300s

log "Pronto. Siga os exercícios do README.md"
