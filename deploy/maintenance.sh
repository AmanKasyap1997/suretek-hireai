#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=deploy/common.sh
source "$(dirname "$0")/common.sh"
trap 'status=$?; if (( status != 0 )); then ping_status /fail; fi' EXIT
lock_operations
case ${1:-} in
  scan) command=documents:scan ;;
  retention) command=retention ;;
  *) echo 'Usage: maintenance.sh scan|retention' >&2; exit 1 ;;
esac
dc run --rm --no-deps api npm run "$command" -- --tenant-id "${TENANT_ID:?}" --actor-id "${MAINTENANCE_ACTOR_ID:?}"
