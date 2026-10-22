#!/usr/bin/env bash
# Volta o Bookinfo do modo ambient para sidecar (desfaz o exercício 7).
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k label ns bookinfo istio.io/use-waypoint- istio.io/dataplane-mode- istio-injection=enabled --overwrite
k delete -f manifests/07-bookinfo-waypoint.yaml --ignore-not-found
k -n bookinfo delete vs reviews --ignore-not-found   # VS do exercício 7 (01-reviews-v1.yaml)

# Recria os pods para o webhook injetar o sidecar de novo
k -n bookinfo rollout restart deploy
for d in $(k -n bookinfo get deploy -o name); do
  k -n bookinfo rollout status "$d" --timeout=180s
done
k -n bookinfo get pods
