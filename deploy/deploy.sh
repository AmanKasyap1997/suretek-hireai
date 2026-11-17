#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=deploy/common.sh
source "$(dirname "$0")/common.sh"
"$DEPLOY_DIR/preflight.sh"
lock_operations
# Do not print expanded Compose configuration: it contains secrets.
dc config --quiet
writes_stopped=false
failed() {
  trap - ERR
  if $writes_stopped; then dc stop -t 60 api caddy >/dev/null 2>&1 || true; fi
  ping_status /fail
  echo 'Deployment aborted. Inspect state; restore backup after migration failure. No automatic schema rollback.' >&2
}
trap failed ERR
[[ -n $(dc ps --status running -q postgres) ]] || { echo 'Initialize PostgreSQL using the first-deploy runbook before deploying' >&2; exit 1; }
"$DEPLOY_DIR/backup.sh"
dc pull api migrate caddy clamav postgres
# Persist the recovery point and old image identity for the operator.
dc images -q api > "$STATE_DIR/previous-api-image"
writes_stopped=true
dc stop -t 60 api
# If migration fails, API stays stopped; never run old code against a partial schema.
dc run --rm --no-deps migrate
dc up -d --wait --wait-timeout 360 postgres clamav api caddy
curl --proto '=https' --fail --silent --show-error --max-time 15 "https://$DOMAIN/api/v1/health/ready" >/dev/null
ping_status ''
echo 'Deployment healthy'
