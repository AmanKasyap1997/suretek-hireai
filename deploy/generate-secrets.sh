#!/usr/bin/env bash
set -euo pipefail
umask 077
command -v openssl >/dev/null
output=${1:-.env}
# Noclobber prevents replacing an existing deployment's credentials.
set -o noclobber
secret() { openssl rand -hex 32; }
{
  cat <<'CONFIG'
# Trusted shell configuration. Keep chmod 600. Fill blank values before preflight.
DOMAIN=
ACME_EMAIL=
IMAGE_TAG=
HIREAI_IMAGE=ghcr.io/amankasyap1997/suretek-hireai
DATA_DIR=/srv/hireai/data
CORS_ORIGINS=
PUBLIC_WEB_BASE_URL=
TRUST_PROXY=1
MALWARE_SCANNER=clamav
CAPTCHA_PROVIDER=turnstile
TURNSTILE_SECRET_KEY=
EMAIL_ADAPTER=smtp
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASSWORD=
SMTP_FROM=
RESUME_STORAGE=local
RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true
BACKUP_AGE_RECIPIENT=
BACKUP_RSYNC_DEST=
BACKUP_RETENTION_DAYS=14
HEALTHCHECK_PING_URL=
TENANT_ID=
MAINTENANCE_ACTOR_ID=
CONFIG
  for key in JWT_SECRET POSTGRES_ADMIN_PASSWORD HIREAI_OWNER_PASSWORD HIREAI_APP_PASSWORD; do
    value=$(secret)
    printf '%s=%s\n' "$key" "$value"
  done
} > "$output"
echo "Created $output (mode 600); fill all blank settings before deployment."
