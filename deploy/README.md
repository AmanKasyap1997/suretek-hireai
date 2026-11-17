# One-server production runbook

Target: one Ubuntu 24.04 Docker Compose v2 server, one tenant. Allocate at least 4 vCPU, 8 GB RAM and monitored SSD capacity; ClamAV has a 3 GB limit. There is no HA, frontend, AI screening, queue or call dispatch. RPO is the last successful daily offsite backup; measure RTO in a restore drill. Scripts require Bash, Compose v2 with `up --wait`, age, rsync/SSH, curl, jq, openssl, tar and util-linux/flock. Production pulls a released version tag, never builds on the server.

## Server hardening

Create a trusted `deploy` user with UID/GID 1000 (or deliberately change the Compose UID and mount ownership). Use SSH keys only, disable password authentication and direct root SSH after testing a second key session. Install Docker from its maintained Ubuntu repository and enable unattended security upgrades; schedule reboot maintenance. Allow inbound TCP 22/80/443 with UFW, deny other inbound traffic and restrict SSH sources where practical. Docker publishing can bypass UFW: also configure the provider firewall. Docker group membership is root-equivalent; restrict it to deploy operators.

Only Caddy publishes ports. Its companion image removes the upstream binary file capability so it can execute with cap_drop ALL on high internal ports; both images use the same release tag. Never publish PostgreSQL, clamd or object storage. Allow outbound DNS, HTTPS for ACME/CAPTCHA/signatures/GHCR, authenticated SMTP and SSH to the backup host. Set the server timezone deliberately: supplied timers follow server time (UTC recommended).

## Directory layout and secrets

Check out the release's code/runbook at `/srv/hireai`. `.env` is a trusted shell file owned by deploy, mode 600; scripts source it. Quote values containing shell metacharacters. Never source untrusted files or print interpolated `compose config`, request bodies or provider responses. `deploy/ci.env` is a syntax-check fixture that is invalid for production.

```sh
cd /srv/hireai
./deploy/generate-secrets.sh
chmod 755 database/init/01-create-roles.sh
chmod 644 deploy/Caddyfile deploy/clamd.conf deploy/freshclam.conf
# Fill every blank setting in .env locally. Do not put secrets in shell history.
sudo install -d -m 700 -o deploy -g deploy /srv/hireai/var
sudo install -d -m 750 -o 1000 -g 1000 /srv/hireai/data/resumes /srv/hireai/data/caddy /srv/hireai/data/caddy-config
sudo install -d -m 700 -o 999 -g 999 /srv/hireai/data/postgres
sudo install -d -m 750 -o 100 -g 101 /srv/hireai/data/clamav
```

`DATA_DIR` defaults to `/srv/hireai/data`. Private persistent `resumes` is the pilot's local volume, deliberately enabled with the existing `RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true` override. It must never be a web root. PostgreSQL, ClamAV signatures and Caddy certificates have separately owned directories. These ownership and host-backup instructions target ordinary Docker on Ubuntu. Rootless Docker requires UID mapping and host backup-read permission adaptations; validate those separately before using it on the server. `var/operations` holds the shared operation lock and last-backup marker; `var/backups` holds encrypted archives.

Set real A/AAAA DNS, `DOMAIN`, `ACME_EMAIL`, `IMAGE_TAG=vX.Y.Z`, exact comma-separated HTTPS `CORS_ORIGINS` without paths/trailing slashes/wildcards, `TRUST_PROXY=1`, and `PUBLIC_WEB_BASE_URL=https://your-web-origin`. Remove incorrect AAAA records. Caddy is the sole trusted proxy, automatically provisions HTTPS and redirects HTTP. HSTS includes subdomains: ensure all affected subdomains support HTTPS. The 1 MB edge limit includes base64 JSON; public resumes remain limited to 512 KiB before encoding.

Set real Turnstile credentials for this domain and action `apply`. Set authenticated `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`: port 587 with `SMTP_SECURE=false` means mandatory STARTTLS; port 465 with `SMTP_SECURE=true` means implicit TLS. TLS 1.2 minimum and certificate verification cannot be disabled. Connection, greeting, socket and total-send deadlines are bounded (`SMTP_TIMEOUT_MS=10000` in Compose). Configure SPF/DKIM/DMARC and verify delivery in a controlled mailbox. Pilot preflight requires real email/CAPTCHA even though general API configuration permits explicit disabled acknowledgements. No resend or durable mail queue is included; intake remains generic on mail failure.

**Verification client boundary:** links use `PUBLIC_WEB_BASE_URL/contact-verification#tenant=...&token=...`. Fragments keep tokens out of HTTP queries and Referer headers. This backend-only milestone supplies no web page. An independently hosted client must read and clear the fragment, then POST `{ "token": "..." }` to `/api/v1/public/:tenantSlug/contact-verification`. Until that client exists, controlled pilot operators must use the verification API directly. Do not send applicants to a nonexistent page or enable contact-dependent calling. Never paste tokens into URL queries/logs/support tickets.

## Offsite backup setup

Generate an age key pair on an independent recovery machine. Keep its private identity offline, separate from this server, and set only the public `age1...` recipient in `BACKUP_AGE_RECIPIENT`. Losing the private key prevents recovery. Provision an empty dedicated offsite directory, e.g. `BACKUP_RSYNC_DEST=backup@backup-host:/backups/hireai/`. Install a restricted SSH key and pin the host key through a separately verified channel. Optional `BACKUP_SSH_KEY_FILE`, `BACKUP_SSH_KNOWN_HOSTS` and `BACKUP_SSH_PORT` select the connection; defaults use deploy's SSH configuration and port 22. Batch mode and strict host-key checking are mandatory.

Backups contain `pg_dump -Fc` of hireai, globals/roles, exact per-table row counts and `resumes.tar`, all encrypted together with age before offsite copy. API writes stop briefly and scan/retention/deploy share a lock so database and files form one recovery point. API restarts using its existing container after backup. Plaintext is removed by exit traps, but power loss can leave mode-700 temporary directories: use encrypted disks and inspect stale `var/operations/backup.*` and `restore.*` after a crash.

Retention defaults to 14 days. The newest archive must upload before pruning; the remote mirrors retained `hireai-*.tar.age` files. **Use a dedicated destination** because matching remote archives are deleted during pruning. Keep additional immutable/offline copies: writable rsync alone cannot protect against a compromised server deleting backups. Monitor remote capacity and backup age independently.

## First deployment

1. Publish a reviewed `vX.Y.Z` tag. The release workflow pushes API and Caddy companion images to GHCR with BuildKit OCI provenance and SBOM attestations, using only contents-read/packages-write permissions. Set package visibility or log Docker in with a read-packages-only credential on the server. Record the image digest and do not move release tags.
2. Create directories, fill `.env`, choose a stable tenant UUID in `TENANT_ID` and temporarily reserve a UUID in `MAINTENANCE_ACTOR_ID` (replace after bootstrap). Run preflight. It validates configuration, not provider connectivity or disk ownership.

   ```sh
   ./deploy/preflight.sh
   dc() { docker compose --env-file /srv/hireai/.env -f /srv/hireai/deploy/compose.prod.yaml "$@"; }
   dc config --quiet
   dc pull postgres clamav api migrate caddy
   # Seed fresh signatures before starting the long-lived scanner.
   dc run --rm --no-deps --entrypoint freshclam clamav --foreground=true
   dc up -d --wait --wait-timeout 360 postgres clamav
   ./deploy/backup.sh
   dc run --rm --no-deps migrate
   ```

   The first backup contains the empty application database. Keep it as the pre-migration recovery point. A fresh signature download can be slow or rate limited; do not accept resumes until clamd is healthy.

3. Bootstrap once using the owner-only migration service. Create a separate mode-600 `bootstrap.env` outside Git containing BOOTSTRAP_TENANT_ID (the same saved UUID), BOOTSTRAP_TENANT_NAME, BOOTSTRAP_TENANT_SLUG, BOOTSTRAP_ADMIN_NAME, BOOTSTRAP_ADMIN_EMAIL and BOOTSTRAP_ADMIN_PASSWORD. In a trusted shell export that file's variables, then run:

   ```sh
   dc run --rm --no-deps -e BOOTSTRAP_TENANT_ID -e BOOTSTRAP_TENANT_NAME -e BOOTSTRAP_TENANT_SLUG -e BOOTSTRAP_ADMIN_NAME -e BOOTSTRAP_ADMIN_EMAIL -e BOOTSTRAP_ADMIN_PASSWORD migrate node dist/scripts/bootstrap.js
   ```

   Capture IDs privately; set `MAINTENANCE_ACTOR_ID` to the actual active admin, remove/unset the bootstrap password/file and rerun preflight. Retries must use the same tenant UUID.

4. Run `dc up -d --wait --wait-timeout 360 api caddy`. Check HTTPS readiness, response `X-Request-ID`, `/docs` and `/docs-json` return 404, and no other service has host ports. Verify ClamAV PING plus an approved EICAR test following readiness operations. Test Turnstile, SMTP receipt and contact verification with controlled data.
5. After bootstrap and successful backup, install timers:

   ```sh
   sudo cp deploy/systemd/hireai-* /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now hireai-scan.timer hireai-retention.timer hireai-backup.timer
   systemctl list-timers 'hireai-*'
   ```

Scan runs every five minutes, retention at 02:30 and backup at 01:30 server time, with randomized delay and missed-run catch-up. Maintenance uses `docker compose run --rm` as hireai_app with an active tenant admin. Lock collisions fail visibly; the next timer invocation retries. Batches are bounded at 100: monitor backlog. Optional HTTPS `HEALTHCHECK_PING_URL` receives `/fail` on operation failures and success on backup/deploy. Use separate service configurations if your dead-man service needs distinct URLs per operation. Also inspect systemd failures; failures before configuration loads cannot ping.

## Upgrade and rollback

Check disk/offsite capacity and a recent restore drill. Stop timers during the change window. Review forward migrations, update the runbook/code checkout and set the reviewed version tag. Run `./deploy/deploy.sh`: preflight, backup/offsite copy, pull, stop API, migrate, restart with health waits, HTTPS readiness. Backup or pull failure prevents migrations. A migration failure leaves the API stopped for recovery. Health failure aborts without automatic reversal. Preserve previous release tag/digest, checkout, config and backup. Never run `compose down -v`.

**Migrations are forward-only. Rollback means restoring a backup**, including the matching resume archive, then starting the compatible previous image. Selecting an older image alone is not a database rollback. PostgreSQL major upgrades require a separate dump/restore plan.

## Restore drill and disaster recovery

Fetch an actual offsite archive onto a trusted recovery host. Temporarily supply the offline age identity, mode 600:

```sh
export AGE_IDENTITY_FILE=/secure/offline-identity
./deploy/restore.sh /secure/hireai-TIMESTAMP.tar.age hireai_restore_drill
# After reviewing success:
dc exec -T postgres dropdb -U postgres hireai_restore_drill
unset AGE_IDENTITY_FILE
```

The script creates a new scratch database, restores the custom dump with exit-on-error, compares exact row counts for every public table, and reads/hashes the resume archive in a temporary scratch directory. It refuses live names and existing scratch databases. It leaves the scratch DB for review; drop it before repeating. It never replays globals into the live cluster. The drill shares the operation lock and needs enough additional disk/RAM. Record backup ID, counts, elapsed restore time and results. Periodically inspect actual restored application/document content as well as counts.

For actual recovery, stop timers/API, provision a separate clean PostgreSQL 17 cluster, initialize roles with the saved secrets and `database/init/01-create-roles.sh`, and inspect `globals.sql` for additional role/grant requirements. Globals contain password hashes; never blindly replay them into a shared/live cluster. Complete the scratch drill first. In an approved outage restore `database.dump` with `pg_restore --exit-on-error` into a new hireai database owned by hireai_owner, extract `resumes.tar` to a new private directory owned 1000:1000, and switch both together. Preserve failed data for investigation. Start the matching previous image, verify health/smoke/tenant isolation, then resume timers. Record lost post-backup data and measured RTO. Remove the temporary identity. No automatic destructive live restore is provided.

## Optional S3 path

The pilot uses local resumes and backs them up. Existing S3ObjectStorage supports a private HTTPS endpoint with bucket, region and least-privilege credentials. The dormant `resume-storage` profile supplies maintained upstream SeaweedFS on the internal network; supply authenticated `deploy/secrets/s3.json`, `s3.crt` and `s3.key` (readable by UID 1000), provision a private bucket and valid trusted TLS before pointing the API at it. Do not use development legacy MinIO in production or expose storage ports. Set S3_INTERNAL_HOST to the DNS name on your trusted certificate and S3_ENDPOINT to https://that-name:8333; the profile adds that internal DNS alias. External private S3 is an alternative. **Pilot preflight rejects non-local storage** until a version-aware offsite backup/restore path, including deleted versions, has been implemented and rehearsed. The optional storage service is never started or backed up by pilot scripts; silently incomplete S3 backups are refused.

## Smoke, monitoring and logs

Run `deploy/smoke.sh https://your-domain` with SMOKE_TENANT_SLUG, SMOKE_JOB_ID (open controlled test job), SMOKE_EMAIL (controlled mailbox), and a fresh hostname/action-matching SMOKE_CAPTCHA_TOKEN. It checks health/public jobs, posts a test application with a PDF and runs the scan sweep. This creates data and sends email. A generic 202 cannot prove persistence: confirm email receipt/verification and CLEAN document status through authenticated APIs, then erase the test candidate. No real deployed smoke is possible without your DNS, mailbox and CAPTCHA token.

Monitor externally every five minutes: readiness, certificate expiry, backup age, disk/inodes and restarts. Readiness tests PostgreSQL only; separately alert on clamd health/signature age, FAILED/PENDING scan backlog, SMTP delivery and timer failures. Alert on offsite backup age >26 hours and certificate expiry <14 days. Use `df -h`, `df -i`, `systemctl --failed`, `journalctl -u hireai-backup.service`, `dc ps`, `var/operations/last-backup-success` and offsite timestamps. Check certificate expiry with `openssl s_client -connect DOMAIN:443 -servername DOMAIN </dev/null 2>/dev/null | openssl x509 -noout -enddate`. Configure provider dead-man alerts; host-local logs cannot detect a dead server.

API logs are JSON with generated request IDs, status and duration; correlate with response X-Request-ID. Never log URLs/query strings, body/headers, tokens, passwords, IPs, addresses or candidate IDs. Arbitrary framework/provider errors retain severity only. Caddy access logs are disabled; internal errors are filtered to omit request/error fields. PostgreSQL statement/parameter logging is disabled and ordinary error logs are suppressed to avoid values embedded in database errors. Do not enable full URI or SMTP debug logging. Docker rotates 3 x 10 MB per service; configure journald retention too. Protect operator records and backups under your retention/access policy.

## Incident checklist

- Stop intake/timers when malware, privacy or integrity is uncertain; preserve restricted evidence with timestamps/request IDs and no PII in tickets.
- Check disk/inodes, OOM/restarts, scanner/signatures/backlog, database, DNS/TLS, SMTP and CAPTCHA.
- Verify the last encrypted offsite backup and offline key. Never delete data volumes or blindly replay globals.
- Restrict access, rotate compromised secrets, assess affected evidence with counsel and reconcile orphaned private objects after failed erasure.
- Restore to scratch, verify counts and document inventory, follow outage recovery and tenant-isolation checks before reopening.
- Record downtime/data loss, review monitoring gaps and rehearse recovery after remediation.
