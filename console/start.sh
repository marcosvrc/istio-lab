#!/usr/bin/env bash
# Compila e inicia o istio-lab console em http://127.0.0.1:7070
# Uso: ./start.sh [-addr 127.0.0.1:7070] [-context rancher-desktop]
set -euo pipefail

cd "$(dirname "$0")"

command -v go >/dev/null || { echo "Go não encontrado (https://go.dev/dl/)" >&2; exit 1; }

# A dependência (yaml.v3) está em vendor/: o build não baixa nada nem usa o
# cache de módulos (contorna GOPATH sem permissão de escrita).
go build -mod=vendor -o bin/istio-lab-console . 2> >(grep -v 'GOPATH and GOROOT' >&2)

exec ./bin/istio-lab-console -repo .. "$@"
