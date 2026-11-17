#!/usr/bin/env bash
# Shared by executable scripts. The mode-600 env file is trusted shell input.
set -euo pipefail
DEPLOY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
ROOT_DIR=$(dirname "$DEPLOY_DIR")
ENV_FILE=${ENV_FILE:-$ROOT_DIR/.env}
[[ -f "$ENV_FILE" && $(stat -c '%a' "$ENV_FILE") == 600 ]] || { echo 'A mode-600 ENV_FILE is required' >&2; exit 1; }
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
STATE_DIR=${STATE_DIR:-$ROOT_DIR/var/operations}
DATA_DIR=${DATA_DIR:-/srv/hireai/data}
export DATA_DIR
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
dc() { docker compose --env-file "$ENV_FILE" -f "$DEPLOY_DIR/compose.prod.yaml" "$@"; }
lock_operations() {
  # Child backup inherits FD 9 from deploy. Never set this variable manually.
  if [[ ${HIREAI_LOCK_HELD:-} != 1 ]]; then
    exec 9>"$STATE_DIR/operation.lock"
    flock -n 9 || { echo 'Another deployment/backup/maintenance operation is active' >&2; ping_status /fail; exit 1; }
    export HIREAI_LOCK_HELD=1
  fi
}
ping_status() {
  local suffix=$1
  [[ -z ${HEALTHCHECK_PING_URL:-} ]] || curl --proto '=https' --max-time 15 --retry 2 -fsS -o /dev/null "${HEALTHCHECK_PING_URL%/}$suffix" 2>/dev/null || true
}

backup_rsync() {
  local ssh_rsh
  local ssh_args=(ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=3 -p "${BACKUP_SSH_PORT:-22}")
  if [[ -n ${BACKUP_SSH_KEY_FILE:-} ]]; then ssh_args+=(-i "$BACKUP_SSH_KEY_FILE" -o IdentitiesOnly=yes); fi
  if [[ -n ${BACKUP_SSH_KNOWN_HOSTS:-} ]]; then ssh_args+=(-o "UserKnownHostsFile=$BACKUP_SSH_KNOWN_HOSTS"); fi
  printf -v ssh_rsh '%q ' "${ssh_args[@]}"
  rsync --timeout=120 -e "$ssh_rsh" "$@"
}

start_existing_api() {
  local container attempt
  container=$(dc ps -aq api)
  [[ -n $container ]] || return 1
  docker start "$container" >/dev/null || return 1
  for ((attempt=0; attempt<45; attempt++)); do
    container=$(dc ps -q api)
    if [[ -n $container && $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]; then return 0; fi
    sleep 2
  done
  echo 'Existing API did not recover after backup' >&2
  return 1
}
