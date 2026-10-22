#!/usr/bin/env bash
# Instala o Istio, os addons de observabilidade e as apps de exemplo do lab.
# Idempotente: pode ser executado de novo sem problemas.
set -euo pipefail

cd "$(dirname "$0")"

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"
ISTIO_VERSION="${ISTIO_VERSION:-$(istioctl version --remote=false 2>/dev/null | awk 'NR==1 {print $NF}')}"
ISTIO_MINOR="${ISTIO_VERSION%.*}"
SAMPLES="https://raw.githubusercontent.com/istio/istio/release-${ISTIO_MINOR}/samples"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
die() { printf '\033[1;31mERRO: %s\033[0m\n' "$*" >&2; exit 1; }

k() { kubectl --context "$KUBE_CONTEXT" "$@"; }

log "Pré-checagens (contexto: $KUBE_CONTEXT, Istio $ISTIO_VERSION)"
command -v istioctl >/dev/null || die "istioctl não encontrado"
k get nodes >/dev/null 2>&1 || die "cluster '$KUBE_CONTEXT' inacessível — o Rancher Desktop já terminou de subir?"
if k -n kube-system get svc traefik >/dev/null 2>&1; then
  die "Traefik está ativo e ocupa as portas 80/443. Desabilite em Rancher Desktop → Preferences → Kubernetes."
fi
istioctl --context "$KUBE_CONTEXT" x precheck

log "Instalando o control plane"
istioctl --context "$KUBE_CONTEXT" install -f istio-operator.yaml -y
k -n istio-system wait --for=condition=Available deployment --all --timeout=300s
istioctl --context "$KUBE_CONTEXT" version

log "Instalando addons (Prometheus, Grafana, Jaeger, Kiali)"
for addon in prometheus grafana jaeger kiali; do
  k apply -f "$SAMPLES/addons/$addon.yaml"
done
k apply -f manifests/telemetry.yaml

log "Namespaces com injeção automática de sidecar"
for ns in bookinfo sandbox; do
  k create namespace "$ns" --dry-run=client -o yaml | k apply -f -
  k label namespace "$ns" istio-injection=enabled --overwrite
done

log "Bookinfo (namespace bookinfo)"
k -n bookinfo apply -f "$SAMPLES/bookinfo/platform/kube/bookinfo.yaml"
k apply -f manifests/destination-rules.yaml -f manifests/bookinfo-gateway.yaml

log "httpbin + curl (namespace sandbox) para testes nos próximos módulos"
k -n sandbox apply -f "$SAMPLES/httpbin/httpbin.yaml"
k -n sandbox apply -f "$SAMPLES/curl/curl.yaml"

log "Aguardando os deployments ficarem prontos"
for ns in istio-system bookinfo sandbox; do
  k -n "$ns" wait --for=condition=Available deployment --all --timeout=300s
done

log "Validando a configuração"
for ns in istio-system bookinfo sandbox; do
  istioctl --context "$KUBE_CONTEXT" analyze -n "$ns"
done

log "Pronto!"
cat <<EOF
  Bookinfo:  http://localhost/productpage
  Kiali:     istioctl dashboard kiali
  Grafana:   istioctl dashboard grafana
  Jaeger:    istioctl dashboard jaeger
  Gerar tráfego: ./traffic.sh
EOF
