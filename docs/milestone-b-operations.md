# Milestone B operations

## Public tenant routing

`tenants.slug` is unique and validated (3–63 lowercase letters/digits/hyphens, no leading/trailing hyphen). Migration 006 backfills `tenant-<UUID>` without changing existing IDs. `BOOTSTRAP_TENANT_SLUG` configures a readable slug; when updating an existing tenant always supply its `BOOTSTRAP_TENANT_ID`. Slug updates are reflected transactionally by the owner-defined trigger.

`public_tenant_directory` is a global routing index containing only the public slug and root tenant UUID. It is not a tenant business table. No runtime or PUBLIC table privileges are granted. The SECURITY DEFINER resolver returns a single UUID and has a fixed `pg_catalog,pg_temp` search path and schema-qualified table reference. There is no dynamic SQL, GUC mutation or RLS bypass. The application resolves the slug, enters an isolated tenant context, then queries published jobs with both explicit tenant predicates and forced RLS. Existing tenant policies and runtime role attributes are unchanged. Owner-only directory synchronization is also fixed-search-path and is callable only as a trigger.

## Intake and consent

The list/detail responses provide `noticeVersion`; clients must send that version on submission. Each consent is an independent boolean defaulting false. The API records source `public-careers`, an unverified flag, notice version, database timestamp, source IP and HMAC-SHA256 of the user-agent (keyed with JWT_SECRET). No identity verification is claimed. Staff must record verified consent through the existing consent workflow before call planning can rely on it; unverified submissions neither grant nor revoke effective verified calling permission.

New/existing candidate and duplicate application cases return the same HTTP 202 body. A duplicate application does not mutate PII, consent or documents. Existing candidates applying to a different job can create a new application and new self-reported evidence. A matching email is not proof of identity. No candidate/application identifiers or upload tokens are returned. A filled honeypot returns the same response without storing applicant data.

The CAPTCHA port is disabled and the stub returns true. No CAPTCHA provider is contacted. `INTAKE_IP_LIMIT` (20), `INTAKE_EMAIL_LIMIT` (5) and `INTAKE_WINDOW_SECONDS` (3600) govern per-tenant fixed-window limits in PostgreSQL. IP/email bucket keys are HMACs, shared across API instances using the same JWT_SECRET. Limits remain effective across process restarts; rotation resets bucket identity. Global public-route throttling also applies (30 requests/minute per IP per handler, process-local). Strict JSON parsing/body limits remain unchanged. Configure proxy trust only for the actual network topology; source IP evidence uses Express's resolved client IP. Expired rate rows are removed on intake and executing retention runs.

## Private storage and scanning

Development/test uses `RESUME_STORAGE=local` and a private root (`var/private/resumes`, ignored by Git), directories mode 0700 and files mode 0600. Never mount this root as a static directory. Production rejects local storage. For S3 set `RESUME_STORAGE=s3`, `S3_ENDPOINT` (HTTPS origin), `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and optional `S3_SESSION_TOKEN`. Manage credentials through deployment secrets. Enable the bucket's public-access block/deny rules; the adapter never requests public ACLs. Requests use SigV4 path-style addressing and bounded API-streamed downloads, not public storage links.

Staff uploads use one multipart `file`, with the configured byte limit (default 5 MiB; hard ceiling 10 MiB). Public intake supports an optional filename/base64 object capped at 512 KiB to retain the existing 1 MiB JSON body limit. PDF signatures and DOCX ZIP/OOXML structure are checked before persistence; names are sanitized, keys are generated UUID pairs, and SHA-256, content type and the S3 object version are recorded. Format validation is not malware scanning. The MalwareScanPort stub always returns PENDING; scanner errors produce ERROR, and only CLEAN allows download. There is no route or environment flag to self-certify CLEAN. Supply a real scanner adapter before enabling downloadable documents; no real malware provider is part of this milestone.

Recruiters/admins can list/upload/download; scoped managers/interviewers and employees have no document permission. Each download rechecks tenant/candidate/document, rejects erased candidates and non-CLEAN statuses, verifies stored bytes against SHA-256, writes an audit event and returns an attachment. Quarantined objects remain private. Database grants do not allow the API role to change scan_status after insertion.

Object writes and PostgreSQL commits cannot form one atomic transaction. Failed upload transactions attempt object cleanup and log a generic operational warning if cleanup fails. Reconcile orphaned keys against candidate_documents using deployment storage inventory when that warning occurs; never expose orphaned objects. No background queue is introduced.

## Erasure and retention

Admins use POST `/candidates/:id/erase`. First a transaction locks the candidate, replaces name/email with an anonymous marker, clears phone, records erased_at, anonymizes document names, appends three verified consent revocations, cancels planned calls and writes an audit event. Consent and audit records are preserved. A second transaction deletes private objects and their metadata. Candidate tombstones block every document read/upload while cleanup is pending. Repeating the request is safe and does not duplicate erasure evidence.

HTTP 200 returns `{id,erased:true,documentsPending:N}`. N=0 confirms storage deletion. If storage is unavailable N remains positive; retry the endpoint after recovery, or run retention. A failure after object deletion but before the metadata transaction commits is safe to retry because object deletion is idempotent. The command prioritizes no tenant other than the one explicitly selected.

Build first, then preview:

```bash
npm run build
npm run retention -- --tenant-id <tenant-uuid> --actor-id <admin-uuid> --dry-run
```

Execute by omitting `--dry-run`; use `--limit 100` to bound each run (maximum 1000). Use DATABASE_URL for the restricted hireai_app role, not migration credentials, and an active HR_ADMIN/SUPER_ADMIN in the selected tenant. The CLI verifies both. It prints aggregate counts, not applicant PII.

`CANDIDATE_RETENTION_DAYS` defaults to 365. Automatic erasure selects dormant candidates older than the cutoff with no recent application/consent activity, no active application, and no employee record. Eligibility is rechecked under the candidate lock before erasure. Erased candidates with pending document deletion are retried regardless of age. Repeat bounded runs until no eligible work remains. Call this command from your deployment scheduler; this milestone adds no queue or scheduler integration.

Erasure targets recruitment candidate PII and resumes; separately controlled employee records, consent evidence, stage evidence and audit history are retained. Such evidence can contain personal data. Validate lawful retention, notice wording, evidence preservation, erasure scope and backup lifecycle with counsel; this implementation is not a legal policy determination. Storage credentials, replicas/backups and provider-side lifecycle/versioning must follow that approved policy. Erasure deletes the recorded S3 object version permanently rather than only creating a delete marker; separately retained replicas/backups still require an approved lifecycle.

## Milestone D readiness

Set `MALWARE_SCANNER=clamav` to use clamd TCP INSTREAM, or explicitly choose `pending`. Production refuses an implicit scanner choice. Configure `CLAMAV_HOST`, `CLAMAV_PORT` (3310) and `CLAMAV_TIMEOUT_MS` (5000, maximum 8000). Requests and replies are bounded; errors produce FAILED, never CLEAN. INFECTED documents remain permanently quarantined and cannot be downloaded or returned to CLEAN. Scan results and quarantine actions have transactional audit evidence.

After building, run `npm run documents:scan -- --tenant-id <UUID> --actor-id <ADMIN_UUID> --limit 100` as `hireai_app`. An active administrator is required. The command uses candidate/document row locks with SKIP LOCKED, rechecks private-object hashes, and retries FAILED/legacy ERROR at most `DOCUMENT_SCAN_MAX_ATTEMPTS` (default 3). Each document is attempted once per invocation; run with cron. There is no job queue. Scans require the clamav adapter; pending mode does not consume retries.

Production requires private HTTPS S3 storage. `RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true` explicitly permits local storage; mount a persistent private volume at `RESUME_STORAGE_ROOT`, owned by container user node (UID 1000), mode 0700. The image filesystem is not persistent storage. No directory should be served publicly.

`docker compose --profile readiness up -d minio clamav` supplies development services. The MinIO container creates the private development bucket on first startup. MinIO ports and clamd are localhost-only; clamd TCP has no authentication and must remain on a private network. MinIO HTTP is for development/tests; production still requires TLS. Set `MINIO_TEST_ENDPOINT=http://127.0.0.1:9000` when running the test suite. The real MinIO test exercises signed upload, download, duplicate rejection, delete and missing-object reads.

Wait for ClamAV signature updates and daemon readiness (`docker compose logs clamav`). With `MALWARE_SCANNER=clamav`, upload a clean PDF and a PDF containing the standard harmless EICAR antivirus test string, run the sweep if needed, and confirm CLEAN versus INFECTED plus denied infected downloads and audit events. Never use actual malware. Fake clamd tests exercise protocol chunking, EICAR responses, truncation and timeouts independently of signature downloads.

Public intake issues a random, expiring, single-use contact token. Only its SHA-256 hash is stored. POST `/api/v1/public/:tenantSlug/contact-verification` with `{ "token": "<selector>.<secret>" }` returns the same generic 202 for valid, expired, used and unknown tokens. Five wrong guesses exhaust a token; verification also has a persistent IP limit. Success appends new verified consent rows referencing the exact intake choices and EMAIL_TOKEN method. It does not mutate old evidence or supersede newer verified consent, erased candidates or changed email addresses. Call planning continues to require verified CALL consent.

EmailPort has a development log adapter; the token is printed only in development/test. Milestone E supplies an authenticated TLS SMTP adapter. Production refuses disabled/log-only email unless EMAIL_DISABLED_ACKNOWLEDGED=true. See [production operations](../deploy/README.md) for SMTP, verification client boundaries and scheduling. Intake remains generic even if delivery fails. There is no durable delivery queue or resend endpoint; duplicate intake does not send another email.

Turnstile uses `CAPTCHA_PROVIDER=turnstile`, `TURNSTILE_SECRET_KEY`, and optional expected hostname/action. Validation fails closed on timeouts, malformed or oversized responses. Production requires Turnstile or explicit `CAPTCHA_DISABLED_ACKNOWLEDGED=true`. Email limits are HMAC-keyed by normalized email plus resolved client IP, charged only after CAPTCHA, notice and resume validation. A different client cannot exhaust a victim's bucket; shared NAT clients still share limits. Independent IP/HTTP throttles remain. Correct `TRUST_PROXY` deployment configuration is essential; do not trust arbitrary forwarded IP headers.
