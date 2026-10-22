# Funções auxiliares do módulo 03. Uso: source ./helpers.sh
# Requer jq.

KUBE_CONTEXT="${KUBE_CONTEXT:-rancher-desktop}"

# promql '<query>' → executa uma consulta instantânea no Prometheus da mesh
promql() {
  local q
  q=$(jq -rn --arg q "$1" '$q|@uri')
  kubectl --context "$KUBE_CONTEXT" -n istio-system exec deploy/prometheus -c prometheus-server -- \
    wget -qO- "http://localhost:9090/api/v1/query?query=$q" |
    jq -r '.data.result[] | "\(.value[1])\t\(.metric | del(.__name__) | to_entries | map("\(.key)=\(.value)") | join(" "))"'
}

# traces <serviço> [n] → últimos n traces do serviço no Jaeger: spans e serviços envolvidos
traces() {
  kubectl --context "$KUBE_CONTEXT" -n istio-system exec deploy/jaeger -- \
    wget -qO- "http://localhost:16686/jaeger/api/traces?service=$1&limit=${2:-5}&lookback=5m" |
    jq -r '.data[] | "\(.traceID)  spans=\(.spans|length)  \([.processes[].serviceName] | unique | join(", "))"'
}

# trace_tags <serviço> → tags do primeiro span do trace mais recente
trace_tags() {
  kubectl --context "$KUBE_CONTEXT" -n istio-system exec deploy/jaeger -- \
    wget -qO- "http://localhost:16686/jaeger/api/traces?service=$1&limit=1&lookback=5m" |
    jq -r '.data[0].spans[0].tags[] | "\(.key)=\(.value)"'
}

# traces_with <serviço> <trecho da url> → quantos traces recentes do serviço têm essa url
traces_with() {
  kubectl --context "$KUBE_CONTEXT" -n istio-system exec deploy/jaeger -- \
    wget -qO- "http://localhost:16686/jaeger/api/traces?service=$1&limit=100&lookback=5m" |
    jq --arg u "$2" '[.data[] | select(any(.spans[].tags[]; .key == "http.url" and (.value | contains($u))))] | length'
}

# mcurl <args> → curl de dentro da mesh (pod curl do namespace sandbox)
mcurl() { kubectl --context "$KUBE_CONTEXT" -n sandbox exec deploy/curl -c curl -- curl -s "$@"; }

# load [n] → n requisições ao Bookinfo (default 50)
load() { for _ in $(seq "${1:-50}"); do curl -s -o /dev/null http://localhost/productpage; done; }
