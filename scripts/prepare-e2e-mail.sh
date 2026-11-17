#!/usr/bin/env bash
set -euo pipefail
# Disposable test-only TLS credentials. This directory is ignored by git/Docker.
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
mkdir -p "$root/work/e2e-mail"
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout "$root/work/e2e-mail/key.pem" \
  -out "$root/work/e2e-mail/cert.pem" -days 1 \
  -subj '/CN=mail' \
  -addext 'subjectAltName=DNS:mail,DNS:localhost,IP:127.0.0.1' > /dev/null 2>&1
# A test container must be able to read these synthetic, short-lived credentials.
chmod 644 "$root/work/e2e-mail/cert.pem" "$root/work/e2e-mail/key.pem"
