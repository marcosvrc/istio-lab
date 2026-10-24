#!/usr/bin/env bash
# Exercício 7 — gera uma CA própria em dois níveis, como numa empresa:
#   root-cert.pem   raiz do lab (autoassinada; em produção fica offline/no HSM)
#   ca-cert.pem     intermediária do cluster, assinada pela raiz: é com ela
#   ca-key.pem      que o istiod assina os certificados dos workloads
#   cert-chain.pem  intermediária + raiz
# Saída em out/ (fora do git: contém chaves privadas). Não sobrescreve uma
# CA já gerada: apague out/ para começar do zero.
set -euo pipefail

cd "$(dirname "$0")"
mkdir -p out && cd out

if [[ -f ca-cert.pem ]]; then
  echo "CA já existe em $(pwd)"
  openssl x509 -in ca-cert.pem -noout -subject -issuer -enddate
  exit 0
fi

openssl genrsa -out root-key.pem 4096 2>/dev/null
openssl req -x509 -new -key root-key.pem -sha256 -days 3650 -out root-cert.pem \
  -subj "/O=Istio Lab/CN=Istio Lab Root CA" \
  -addext "basicConstraints=critical,CA:true" \
  -addext "keyUsage=critical,keyCertSign,cRLSign"

openssl genrsa -out ca-key.pem 4096 2>/dev/null
openssl req -new -key ca-key.pem -out ca.csr -subj "/O=Istio Lab/CN=Istio Lab Intermediate CA - rancher-desktop"
cat > ca.ext <<'EXT'
basicConstraints=critical,CA:true,pathlen:0
keyUsage=critical,digitalSignature,keyCertSign,cRLSign
subjectAltName=DNS:istiod.istio-system.svc
EXT
openssl x509 -req -in ca.csr -CA root-cert.pem -CAkey root-key.pem -CAcreateserial \
  -sha256 -days 730 -extfile ca.ext -out ca-cert.pem 2>/dev/null
cat ca-cert.pem root-cert.pem > cert-chain.pem
rm -f ca.csr ca.ext

openssl verify -CAfile root-cert.pem ca-cert.pem
openssl x509 -in ca-cert.pem -noout -subject -issuer -enddate
