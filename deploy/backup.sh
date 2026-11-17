#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=deploy/common.sh
source "$(dirname "$0")/common.sh"
# Cover preflight/tool failures before the full cleanup trap can be installed.
trap 'status=$?; if (( status != 0 )); then ping_status /fail; fi' EXIT
"$DEPLOY_DIR/preflight.sh" >/dev/null
lock_operations
for tool in age rsync tar; do command -v "$tool" >/dev/null; done
BACKUP_DIR=${BACKUP_DIR:-$ROOT_DIR/var/backups}
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
work=$(mktemp -d "$STATE_DIR/backup.XXXXXX")
api_was_running=false
finish() {
  local status=$?
  trap - EXIT
  rm -rf -- "$work"
  if $api_was_running; then start_existing_api >/dev/null || status=1; fi
  if (( status == 0 )); then
    date -u +%FT%TZ > "$STATE_DIR/last-backup-success"
    ping_status ''
    echo 'Encrypted offsite backup completed'
  else
    ping_status /fail
    echo 'Backup failed; deployment must not continue' >&2
  fi
  exit "$status"
}
trap finish EXIT
if [[ -n $(dc ps --status running -q api) ]]; then
  api_was_running=true
  dc stop -t 60 api >/dev/null
fi
# All data-changing maintenance shares the operation lock. API writes are stopped.
dc exec -T postgres pg_dump -U postgres -d hireai -Fc > "$work/database.dump"
dc exec -T postgres pg_dumpall -U postgres --globals-only > "$work/globals.sql"
dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -At -U postgres -d hireai < "$DEPLOY_DIR/row-counts.sql" > "$work/row-counts.txt"
tar -C "$DATA_DIR/resumes" -cpf "$work/resumes.tar" .
archive="$BACKUP_DIR/hireai-$(date -u +%Y%m%dT%H%M%S)-$$.tar.age"
tar -C "$work" -cf - database.dump globals.sql row-counts.txt resumes.tar | age -r "$BACKUP_AGE_RECIPIENT" -o "$archive.partial"
mv -- "$archive.partial" "$archive"
# Copy the new backup before pruning anything. SSH must have a pinned known_hosts.
backup_rsync -a -- "$archive" "$BACKUP_RSYNC_DEST"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'hireai-*.tar.age' -mtime "+${BACKUP_RETENTION_DAYS:-14}" -delete
# Dedicated backup destination only; unrelated remote files are excluded from deletion.
backup_rsync -a --delete --include='hireai-*.tar.age' --exclude='*' -- "$BACKUP_DIR/" "$BACKUP_RSYNC_DEST"
