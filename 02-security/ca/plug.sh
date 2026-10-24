#!/usr/bin/env bash
# Exercício 7 — configura o secret istio-system/cacerts e reinicia o istiod.
# Uso: ./plug.sh <modo>
#   lab           assina com a CA do lab e confia só na raiz do lab (troca seca)
#   trust-both    assina com a CA do lab e confia nas duas raízes
#   orig-signer   assina com a CA original do istiod e confia nas duas raízes
#   remove        apaga o cacerts: o istiod volta à CA autoassinada (istio-ca-secret)
# Depois de cada passo, os workloads só recebem certificado e trust bundle
# novos quando são recriados: ./restart-mesh.sh
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

[[ -f out/ca-cert.pem ]] || ./gen-ca.sh

# CA original (autoassinada) que o istiod gerou na instalação
if [[ ! -f out/orig/ca-cert.pem ]]; then
  mkdir -p out/orig
  for f in ca-cert.pem ca-key.pem root-cert.pem; do
    k -n istio-system get secret istio-ca-secret -o jsonpath="{.data.${f//./\\.}}" | base64 -d > "out/orig/$f"
  done
fi

secret() {  # secret <ca-cert> <ca-key> <cert-chain> <root-cert...>
  local cert=$1 key=$2 chain=$3; shift 3
  cat "$@" > out/root-bundle.pem
  k -n istio-system create secret generic cacerts --dry-run=client -o yaml \
    --from-file=ca-cert.pem="$cert" --from-file=ca-key.pem="$key" \
    --from-file=cert-chain.pem="$chain" --from-file=root-cert.pem=out/root-bundle.pem |
    k apply --server-side --force-conflicts -f -
}

case "${1:-}" in
  lab)         secret out/ca-cert.pem out/ca-key.pem out/cert-chain.pem out/root-cert.pem ;;
  trust-both)  secret out/ca-cert.pem out/ca-key.pem out/cert-chain.pem out/root-cert.pem out/orig/root-cert.pem ;;
  orig-signer) secret out/orig/ca-cert.pem out/orig/ca-key.pem out/orig/ca-cert.pem out/orig/root-cert.pem out/root-cert.pem ;;
  remove)      k -n istio-system delete secret cacerts --ignore-not-found ;;
  *) echo "uso: $0 lab | trust-both | orig-signer | remove" >&2; exit 1 ;;
esac

k -n istio-system rollout restart deploy/istiod
k -n istio-system rollout status deploy/istiod --timeout=180s
