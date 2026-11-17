# Milestone E implementation report

Implemented on `feature/ta-milestone-e-self-hosted-deployment`, based on `6af4ed1`. Milestone E was added to the plan and status table before implementation. The attached blueprint was reference material; the explicit request and plan Working rules defined scope. No schema migrations, enums, tables, endpoint contracts, frontend, AI screening, queue, call dispatch, Kubernetes or HA were added.

## Decisions

- Nodemailer is the only new runtime dependency. It supplies authenticated SMTP, mandatory verified TLS, MIME text/HTML and cancellable sends. SMTP-server and type packages are development-only fake-server test dependencies. Implicit TLS and required STARTTLS are both tested; credentials and provider responses are never logged. Total send deadline uses Nodemailer 10's AbortSignal support in addition to socket/connection/greeting timeouts.
- Verification links use a fragment at PUBLIC_WEB_BASE_URL. No frontend is implemented: the runbook states the external verification-client boundary and gives the existing POST API workflow. There is no resend or durable mail queue.
- The general application permits an explicit email-disabled acknowledgement; the pilot preflight requires real SMTP, Turnstile and ClamAV. It also requires a dedicated age/rsync offsite configuration, a real domain, strong unique database secrets and tenant/admin maintenance IDs.
- The private backend network is Docker-internal. API and scanner additionally join an unexposed egress bridge because SMTP, CAPTCHA and signature updates require outbound internet access. Only Caddy publishes host ports. Migration is a one-shot service, so restart is disabled and no ongoing healthcheck is meaningful.
- The existing production-local resume override enables a persistent bind volume for this single-server pilot. Optional private HTTPS S3/SeaweedFS is documented and isolated behind a profile. Automated pilot preflight deliberately rejects S3 until version-aware offsite backup/recovery is implemented, preventing incomplete backups.
- Caddy's upstream binary has a file capability that prevents execution with an empty capability bounding set. A small companion image removes that xattr, runs non-root and uses high internal ports. Both API and companion are published with matching version tags and OCI provenance/SBOM attestations. Native BuildKit attestations need no GitHub id-token/attestations-write permissions; only contents-read/packages-write are granted. These are OCI attestations, not a claim of GitHub-signed artifact attestations.
- Backups lock all maintenance and briefly stop the API so DB dumps and resumes form one recovery point. The existing API container is restarted directly (without pulling/changing its image) and checked for health. Offsite upload must succeed before retention pruning. Live restore is deliberately manual; restore.sh only creates scratch databases. Migrations are forward-only: rollback requires restoring a backup and its matching resumes.
- JSON HTTP logs contain a generated request ID, method, status and duration. No URLs, queries, headers, bodies, IPs or personal identifiers are logged. Arbitrary framework/provider messages retain severity only. Caddy access logs are off and request/error context is filtered; PostgreSQL statement/value logging is suppressed. This favors privacy over detailed production exception text.

## Commands and results

| Check                                                                                 | Result                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci --cache /workspace/.npm-cache`                                                | Passed, locked dependencies installed                                                                                                                                                           |
| `npm run enums:check`                                                                 | Passed, canonical snapshot unchanged                                                                                                                                                            |
| `npm run lint`                                                                        | Passed                                                                                                                                                                                          |
| `npm run format:check`                                                                | Passed                                                                                                                                                                                          |
| `npm run build`                                                                       | Passed                                                                                                                                                                                          |
| `npm run db:migrate` twice on fresh PostgreSQL 17 as hireai_owner                     | Passed, all 11 migrations applied then safely skipped                                                                                                                                           |
| Production `docker compose run --rm --no-deps migrate` twice on another fresh DB      | Passed using the built production image and owner-only credentials                                                                                                                              |
| `npm test` with DATABASE_URL using hireai_app                                         | **27 suites, 189 tests and 1 snapshot passed**, including RLS coverage/isolation, real MinIO, fake TLS SMTP, logging, production refusals and preflight                                         |
| Preflight tests after the final secret-generator failure-handling adjustment          | Passed                                                                                                                                                                                          |
| `docker compose --env-file deploy/ci.env -f deploy/compose.prod.yaml config --quiet`  | Passed; optional resume-storage profile config also passed                                                                                                                                      |
| `shellcheck deploy/*.sh database/init/*.sh`                                           | Passed for every shell script (ShellCheck 0.10.0)                                                                                                                                               |
| Production API image build                                                            | Passed with a temporary equivalent Dockerfile mounting the managed environment's proxy CA as a BuildKit secret; TLS verification stayed enabled and no CA was committed or baked into the image |
| `docker build -f deploy/Dockerfile.caddy ...`                                         | Passed                                                                                                                                                                                          |
| Hardened production PostgreSQL and API containers                                     | Started non-root with read-only roots, dropped capabilities and configured limits; API readiness returned 200                                                                                   |
| Original Caddyfile validation                                                         | Passed in the capability-free companion image                                                                                                                                                   |
| Caddy runtime with a trusted local test CA                                            | HTTPS health 200, docs/docs-json 404, security headers/request IDs present, 1 MB overflow 413, HTTP redirects to external HTTPS without :8443; query-secret probe absent from logs              |
| `deploy/backup.sh` against local PostgreSQL plus a separate local SSH/rsync container | Passed: encrypted custom dump, globals and resumes copied; API stop/recovery also passed                                                                                                        |
| `deploy/restore.sh` into hireai_restore_drill                                         | Passed: exact public-table row counts matched, nonempty tenant fixture restored, resume archive read/hashed; scratch DB dropped afterward                                                       |
| Hardened real ClamAV container                                                        | PONG; clean INSTREAM OK; EICAR FOUND                                                                                                                                                            |
| `systemd-analyze calendar '*:0/5'`                                                    | Parsed as every five minutes                                                                                                                                                                    |
| `git diff --check`                                                                    | Passed                                                                                                                                                                                          |

The unmodified initial image-build attempt hit the managed filesystem's 8 GB/VFS limit; another attempt hit its injected TLS proxy CA. Staging image tests and removing only task-created caches/images resolved disk pressure. The successful API build used an uncommitted CA-secret adaptation of the same Dockerfile. SSH in this environment also had an invalid system-config ownership entry; the local offsite drill used a session-only `ssh -F /dev/null` wrapper with strict pinned host-key verification and the explicit test identity. These environment workarounds are not production code.

## Verification limits

No real server was deployed and no release tag/image was pushed to GHCR. GitHub Actions execution, GHCR package permissions/attestation inspection, real DNS/ACME issuance, SMTP deliverability/SPF/DKIM/DMARC, production Turnstile and the deployed-URL smoke remain operator checks. Caddy TLS tests used a local trusted CA, not public ACME. The backup destination was an independent local SSH container, not a remote offsite provider. Optional SeaweedFS/S3 was syntax-checked, not started. Live ClamAV signature download failed behind the managed network's proxy; the real scan used the image's existing current signature database. systemd unit installation/execution was not verified: `systemd-analyze verify` was blocked by read-only `/run/systemd`; calendar parsing succeeded. Production instructions target ordinary Docker; rootless UID/host-backup-read adaptations require separate validation.

## Manual real-server checklist

- [ ] Harden Ubuntu: deploy user, SSH keys only, direct root/password login off, UFW/provider firewall 22/80/443, unattended upgrades and reboot policy.
- [ ] Provision RAM/disk/inode monitoring, correct persistent directory owners, Docker/Compose and runbook tools.
- [ ] Generate the mode-600 env, fill real domain/DNS, exact CORS/web origin, SMTP/Turnstile and backup configuration; run preflight.
- [ ] Keep age private key offline; pin backup SSH host key, verify dedicated offsite retention and immutable/offline copies.
- [ ] Publish reviewed version tags for API and Caddy, configure GHCR read access and inspect provenance/SBOM/digests.
- [ ] Seed ClamAV signatures and verify updates, PING, clean and EICAR behavior.
- [ ] Initialize DB, take initial backup, migrate and bootstrap exactly one tenant; save actual maintenance admin ID and remove bootstrap password.
- [ ] Verify real automatic HTTPS, docs blocking, request IDs, headers, body limits and host port inventory.
- [ ] Verify SMTP delivery and contact verification with a controlled mailbox; supply an external verification client before applicant use.
- [ ] Run deployed smoke with controlled job/mailbox and a fresh Turnstile token; inspect CLEAN status and erase test data.
- [ ] Fetch an actual offsite archive, rehearse scratch restore/count/content checks and record RPO/RTO.
- [ ] Install/enable timers, optional failure pings/dead-man checks, journald retention and disk/backup-age/certificate/backlog alerts.

## PR description

Title: Implement Milestone E single-server self-hosted production deployment

Adds the Ubuntu 24.04 single-tenant production path: authenticated mandatory-TLS SMTP, tagged GHCR API/Caddy images with provenance/SBOM, hardened private Compose, systemd scan/retention/backup timers, encrypted offsite backups and scratch restore, strict preflight/secret generation/deployment/smoke scripts, privacy-preserving JSON request logs and an operations runbook. Caddy's companion strips its upstream file capability so cap_drop ALL works. Nodemailer is the single new runtime dependency, supplying SMTP/TLS/authentication/MIME and cancellable sends; fake SMTP dependencies are test-only.

Validation: npm ci, enum guard, lint, formatting, build, migrations twice as owner, all 189 tests as hireai_app including RLS and real MinIO, Compose config, all-script shellcheck, both production image builds, hardened Caddy/ClamAV probes and a local encrypted backup/offsite-copy/scratch-restore drill passed. API build required a session-only proxy CA secret. Public ACME, real SMTP/Turnstile, GitHub publishing, systemd execution and deployed smoke require server validation. No schema/API contract changes; no frontend, AI screening, queue, call dispatch, Kubernetes or HA.

## Complete file inventory

- `.dockerignore`
- `.env.example`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.gitignore`
- `README.md`
- `compose.yaml`
- `deploy/Caddyfile`
- `deploy/Dockerfile.caddy`
- `deploy/README.md`
- `deploy/backup.sh`
- `deploy/ci.env`
- `deploy/clamd.conf`
- `deploy/common.sh`
- `deploy/compose.prod.yaml`
- `deploy/deploy.sh`
- `deploy/freshclam.conf`
- `deploy/generate-secrets.sh`
- `deploy/maintenance.sh`
- `deploy/preflight.sh`
- `deploy/restore.sh`
- `deploy/row-counts.sql`
- `deploy/smoke.sh`
- `deploy/systemd/hireai-backup.service`
- `deploy/systemd/hireai-backup.timer`
- `deploy/systemd/hireai-retention.service`
- `deploy/systemd/hireai-retention.timer`
- `deploy/systemd/hireai-scan.service`
- `deploy/systemd/hireai-scan.timer`
- `docs/api-examples.http`
- `docs/blueprint-scope.md`
- `docs/hardening.md`
- `docs/milestone-b-operations.md`
- `docs/ta-milestone-e-report.md`
- `docs/talent-acquisition-plan.md`
- `package-lock.json`
- `package.json`
- `scripts/documents-scan.ts`
- `scripts/migrate.ts`
- `scripts/retention.ts`
- `src/app.setup.ts`
- `src/integrations/README.md`
- `src/integrations/integrations.module.ts`
- `src/integrations/smtp-email.ts`
- `src/main.ts`
- `src/platform/config.ts`
- `src/platform/http/exception.filter.ts`
- `src/platform/http/logging.ts`
- `test/deploy-preflight.spec.ts`
- `test/logging.spec.ts`
- `test/production-config.spec.ts`
- `test/rls.integration.spec.ts`
- `test/smtp-email.spec.ts`
