#!/usr/bin/env bash
set -euo pipefail
umask 077
# shellcheck source=deploy/common.sh
source "$(dirname "$0")/common.sh"
lock_operations
: "${AGE_IDENTITY_FILE:?Set AGE_IDENTITY_FILE to the offline age private key}"
archive=${1:?Usage: restore.sh archive.tar.age [hireai_restore_name]}
scratch=${2:-hireai_restore_drill}
[[ $scratch =~ ^hireai_restore_[a-z0-9_]+$ ]] || { echo 'Only a scratch database named hireai_restore_* is allowed' >&2; exit 1; }
work=$(mktemp -d "$STATE_DIR/restore.XXXXXX")
finish() {
  local status=$?
  rm -rf -- "$work"
  if (( status == 0 )); then ping_status ''; else ping_status /fail; fi
}
trap finish EXIT
age -d -i "$AGE_IDENTITY_FILE" -o "$work/backup.tar" "$archive"
# Extract only the four expected regular files; never trust archive paths.
for file in database.dump globals.sql row-counts.txt resumes.tar; do
  tar -xOf "$work/backup.tar" "$file" > "$work/$file"
done
# Never replay globals into a live cluster. Inspect encrypted globals on a separate
# recovery cluster, then run the normal role initializer before restoring data.
dc exec -T postgres createdb -U postgres -O hireai_owner "$scratch"
dc exec -T postgres pg_restore -U postgres --exit-on-error -d "$scratch" < "$work/database.dump"
dc exec -T postgres psql -X -v ON_ERROR_STOP=1 -At -U postgres -d "$scratch" < "$DEPLOY_DIR/row-counts.sql" > "$work/restored-counts.txt"
diff -u "$work/row-counts.txt" "$work/restored-counts.txt"
# Verify the resume archive can be read; extraction occurs only in a scratch folder.
mkdir "$work/resumes"
tar --no-same-owner --no-same-permissions -xf "$work/resumes.tar" -C "$work/resumes"
find "$work/resumes" -type f -exec sha256sum {} + > /dev/null
printf 'Restore drill passed: row counts match in %s. Drop the scratch DB after review.\n' "$scratch"
