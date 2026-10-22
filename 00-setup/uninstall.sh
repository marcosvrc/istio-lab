#!/usr/bin/env bash
# Remove tudo que o install.sh criou.
set -euo pipefail

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

k delete namespace bookinfo sandbox --ignore-not-found
istioctl --context "$KUBE_CONTEXT" uninstall --purge -y
k delete namespace istio-system --ignore-not-found
