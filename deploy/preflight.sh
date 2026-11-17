#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=deploy/common.sh
source "$(dirname "$0")/common.sh"
fail() { echo "Preflight: $1" >&2; exit 1; }
required=(DOMAIN ACME_EMAIL IMAGE_TAG JWT_SECRET POSTGRES_ADMIN_PASSWORD HIREAI_OWNER_PASSWORD HIREAI_APP_PASSWORD MALWARE_SCANNER CAPTCHA_PROVIDER TURNSTILE_SECRET_KEY EMAIL_ADAPTER SMTP_HOST SMTP_USER SMTP_PASSWORD SMTP_FROM PUBLIC_WEB_BASE_URL CORS_ORIGINS BACKUP_AGE_RECIPIENT BACKUP_RSYNC_DEST TENANT_ID MAINTENANCE_ACTOR_ID)
for key in "${required[@]}"; do [[ -n ${!key:-} ]] || fail "missing $key"; done
for key in POSTGRES_ADMIN_PASSWORD HIREAI_OWNER_PASSWORD HIREAI_APP_PASSWORD JWT_SECRET; do
  value=${!key}
  [[ ${#value} -ge 32 && $value =~ ^[A-Za-z0-9_-]+$ && ! ${value,,} =~ dev_only|postgres|password|change|replace|placeholder ]] || fail "unsafe $key (use generated URI-safe secrets)"
done
[[ $POSTGRES_ADMIN_PASSWORD != "$HIREAI_OWNER_PASSWORD" && $POSTGRES_ADMIN_PASSWORD != "$HIREAI_APP_PASSWORD" && $HIREAI_OWNER_PASSWORD != "$HIREAI_APP_PASSWORD" ]] || fail 'database passwords must differ'
[[ $DOMAIN =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$ && ! $DOMAIN =~ example\.(com|org|net)$|localhost ]] || fail 'a real DNS domain is required'
[[ $IMAGE_TAG =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'IMAGE_TAG must be a version tag'
[[ $PUBLIC_WEB_BASE_URL =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?/?$ ]] || fail 'PUBLIC_WEB_BASE_URL must be an HTTPS origin'
IFS=',' read -ra origins <<< "$CORS_ORIGINS"
[[ ${#origins[@]} -gt 0 && $CORS_ORIGINS != *, ]] || fail 'exact CORS origins required'
for origin in "${origins[@]}"; do [[ $origin =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || fail 'CORS requires exact HTTPS origins'; done
[[ $MALWARE_SCANNER == clamav ]] || fail 'ClamAV scanner is required for the pilot'
[[ $CAPTCHA_PROVIDER == turnstile && $TURNSTILE_SECRET_KEY != *placeholder* ]] || fail 'real CAPTCHA is required'
[[ ${#SMTP_PASSWORD} -ge 16 && ! ${SMTP_PASSWORD,,} =~ dev_only|password|change|replace|placeholder ]] || fail 'unsafe SMTP_PASSWORD'
[[ $EMAIL_ADAPTER == smtp && $SMTP_FROM == *@* && $SMTP_HOST != localhost ]] || fail 'real SMTP is required'
[[ $BACKUP_AGE_RECIPIENT =~ ^age1[0-9a-z]{58}$ ]] || fail 'an age public recipient is required'
[[ $BACKUP_RSYNC_DEST =~ ^[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:/[A-Za-z0-9_./-]+/$ ]] || fail 'BACKUP_RSYNC_DEST must be user@host:/dedicated/path/'
[[ ${BACKUP_RETENTION_DAYS:-14} =~ ^[1-9][0-9]*$ ]] || fail 'positive backup retention required'
for key in TENANT_ID MAINTENANCE_ACTOR_ID; do [[ ${!key} =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] || fail "invalid $key"; done
[[ ${RESUME_STORAGE:-local} == local ]] || fail 'automated pilot backups require local storage; implement S3 versioned backup before switching'
[[ ${RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION:-} == true ]] || fail 'persistent local storage acknowledgement required'
[[ ${TRUST_PROXY:-} == 1 ]] || fail 'TRUST_PROXY=1 required'
[[ -z ${HEALTHCHECK_PING_URL:-} || $HEALTHCHECK_PING_URL == https://* ]] || fail 'healthcheck ping must use HTTPS'
echo 'Preflight configuration passed'
