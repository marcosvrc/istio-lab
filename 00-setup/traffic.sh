#!/usr/bin/env bash
# Gera tráfego contínuo no Bookinfo para alimentar Kiali, Grafana e Jaeger.
# Uso: ./traffic.sh [intervalo_em_segundos]   (Ctrl+C para parar)
set -euo pipefail

URL="${URL:-http://localhost/productpage}"
INTERVAL="${1:-0.5}"

echo "Enviando requisições para $URL a cada ${INTERVAL}s..."
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$URL" || echo "000")
  printf '%s %s\n' "$(date +%T)" "$code"
  sleep "$INTERVAL"
done
