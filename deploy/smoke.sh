#!/usr/bin/env bash
set -euo pipefail
# Deliberate test data only; this creates an application and sends an email.
# shellcheck source=deploy/common.sh
source "$(dirname "$0")/common.sh"
base=${1:?Usage: smoke.sh https://deployed-domain}
[[ $base =~ ^https://[a-zA-Z0-9.-]+(:[0-9]+)?$ ]] || exit 1
: "${SMOKE_TENANT_SLUG:?}" "${SMOKE_JOB_ID:?}" "${SMOKE_EMAIL:?Use a controlled test mailbox}" "${SMOKE_CAPTCHA_TOKEN:?Fresh Turnstile token for apply}"
work=$(mktemp -d "$STATE_DIR/smoke.XXXXXX")
trap 'rm -rf -- "$work"' EXIT
curl --proto '=https' -fsS --max-time 20 "$base/api/v1/health/ready" > /dev/null
curl --proto '=https' -fsS --max-time 20 "$base/api/v1/public/$SMOKE_TENANT_SLUG/jobs" > /dev/null
# Use jq rather than shell interpolation for JSON escaping. Bodies never enter logs.
jq -n --arg email "$SMOKE_EMAIL" --arg captcha "$SMOKE_CAPTCHA_TOKEN" --arg notice "${INTAKE_NOTICE_VERSION:-2026-11-v1}" \
  '{fullName:"Deployment Smoke Test",email:$email,captchaToken:$captcha,noticeVersion:$notice,consents:{CALL:false,RECORDING:false,TRANSCRIPTION:false},resume:{filename:"smoke.pdf",base64:"JVBERi0xLjQKJSVFT0YK"}}' > "$work/application.json"
code=$(curl --proto '=https' -sS --max-time 30 -o "$work/result" -w '%{http_code}' -H 'Content-Type: application/json' --data-binary "@$work/application.json" "$base/api/v1/public/$SMOKE_TENANT_SLUG/jobs/$SMOKE_JOB_ID/applications")
[[ $code == 202 ]] || { echo "Application smoke failed: HTTP $code" >&2; exit 1; }
"$DEPLOY_DIR/maintenance.sh" scan
echo 'Smoke passed: readiness, public jobs, test application, scan sweep. Review test document scan status in the authenticated API.'
