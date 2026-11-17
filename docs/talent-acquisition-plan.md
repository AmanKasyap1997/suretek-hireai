# Talent Acquisition plan

| Milestone | Status   |
| --------- | -------- |
| A         | Complete |
| B         | Complete |
| C         | Complete |
| D         | Complete |
| E         | Complete |

## Working rules (apply to every milestone)

- Follow existing conventions: domain-enum workflow (enums:check and the generated constraint migrations), zod schemas, Actor, transactional audit events, composite (tenant_id, id) foreign keys, forward-only numbered migrations (never edit applied ones).
- Every new tenant table: tenant_id column, composite FKs, RLS ENABLE + FORCE with the tenant_isolation policy, and exact least-privilege grants to hireai_app in the same migration (append-only evidence tables get SELECT and INSERT only). Index with tenant_id first.
- Add an RLS coverage guard test: introspect pg_catalog and fail if any public table with a tenant_id column lacks an enabled+forced RLS policy. Add cross-tenant tests for every new table and endpoint.
- Keep explicit WHERE tenant_id filters in queries (RLS is defence in depth).
- Additive API changes only: existing endpoints keep their routes, status codes and response shapes.
- AI never decides a hiring outcome. No AI provider, queue, telephony or calendar integration is called in these milestones; define ports/interfaces only where stated.
- Do not commit secrets. No new runtime dependency unless unavoidable and justified in the PR.
- Update README, docs/blueprint-scope.md, docs/api-examples.http and docs/hardening.md for what you change.

## Milestone A: core data, access and workflow (implemented)

A1. Job requirements: extend jobs with openings, location, employment_type, salary band (min/max, nullable), hiring_manager_user_id, screening_criteria (validated structured list: id, label, weight, must_have), closed_at and close_reason. Keep the existing job state machine; add states only through the enum workflow if needed.
A2. Assignments and scoped access: table job_assignments (job, user, assignment role: HIRING_MANAGER | INTERVIEWER | RECRUITER_OWNER). Add one central access-policy service so that ownership checks live in one place. HIRING_MANAGER and INTERVIEWER users currently have no routes: give them read access ONLY to jobs and applications they are assigned to (and HIRING_MANAGER may shortlist or reject on those). Role checks never substitute for assignment checks. Test that an unassigned hiring manager gets 404 (not 403) for other jobs.
A3. Stage history: append-only application_stage_events (application, from_stage, to_stage, reason_code, note, actor, created_at). Every stage change writes one event in the same transaction. REJECTED requires a reason_code (enum). Backfill one initial event per existing application in the migration. Expose GET /applications/:id/history.
A4. Offers: allow DECLINED, WITHDRAWN and EXPIRED states and re-issuing a revised offer (replace the one-offer-per-application unique rule with a partial unique index allowing one ACTIVE offer per application, keep the history). Maker-checker: the approver must differ from the creator (configurable via env, default on in production). Add expires_at.
A5. Search and lists: optional filters on candidates, applications and jobs (job, stage, status, created range, text search on name and email), sort whitelist, a total count added in a backward-compatible way, and supporting indexes. Add trigram search only if the extension is available without superuser rights; otherwise use ILIKE and document the limit.
A6. Tests: unit tests for the state machines and the access policy; integration tests for every new endpoint including permission-denied, cross-tenant and RLS paths; migration idempotency.

## Milestone B (implemented): intake, consent, resumes, retention

B1. tenants.slug and a public tenant resolution that does not weaken RLS: a narrow SECURITY DEFINER function with fixed search_path returning only the tenant id for a slug, EXECUTE granted to hireai_app.
B2. Unauthenticated careers API: GET /public/:tenantSlug/jobs, GET /public/:tenantSlug/jobs/:id, POST /public/:tenantSlug/jobs/:id/applications. Strict validation, per-IP and per-email rate limits, honeypot field, CaptchaPort interface with a disabled stub, the same response whether or not the candidate already exists, no staff-only fields exposed.
B3. Consent at intake: separate unchecked-by-default CALL, RECORDING and TRANSCRIPTION consents written to the append-only consents ledger with notice version, timestamp, IP and user-agent hash.
B4. Resumes: ObjectStoragePort with a local filesystem adapter (dev) and an S3-compatible adapter; private storage; PDF and DOCX only verified by magic bytes; size limit; sanitized names; sha256; table candidate_documents with scan_status; MalwareScanPort (stub clearly labeled); a document is not downloadable until scan_status is CLEAN; every download is authorized, audited and served via short-lived signed URL or streamed by the API.
B5. Retention and erasure: configurable retention period, staff erase-candidate action that anonymizes PII and deletes documents while keeping consent evidence and audit records, and a CLI command to run retention. Note in docs that legal requirements must be validated with counsel.

## Milestone C (implemented): interviews, scorecards, reports

C1. interviews (application, round, mode, start/end, location or link, status), interview_panelists, with an exclusion constraint preventing overlapping interviews for the same panelist.
C2. scorecards per panelist: scores against the job's screening criteria, recommendation enum, notes; immutable once submitted; interviewers can only see and submit for interviews they are assigned to.
C3. CalendarPort interface with a stub only (no real calendar integration yet).
C4. Reports from stage events: funnel by job and period, time-in-stage, time-to-hire; restricted to admin and recruiter roles; indexed.

## Milestone D: Phase 1 readiness

D1. Malware scanning: add ClamAvScanner behind MalwareScanPort using clamd INSTREAM over TCP, with bounded chunks, total size, replies and timeouts. Configure MALWARE_SCANNER=clamav|pending; production requires an explicit choice. A tenant-scoped documents:scan batch CLI locks eligible documents with FOR UPDATE SKIP LOCKED, records CLEAN/INFECTED/FAILED and scanned_at, audits results transactionally, retries failures with a cap and never reuses infected documents. Grant updates only to the scanning fields. Use a fake clamd server, including EICAR, in tests; provide optional Compose ClamAV and real-scanner verification instructions.

D2. Storage safety: production requires S3 unless RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION=true explicitly permits a persistent private local volume. Add MinIO to Compose and CI, and exercise actual S3ObjectStorage upload/download/delete/missing-object round trips against it. Fix protocol/signing defects exposed by these checks.

D3. Contact verification: introduce EmailPort and a log-only development adapter, without a provider integration. Public intake issues a single-use, expiring token with only its hash persisted. Verification uses constant-time comparison and bounded attempts, has a generic response for existing/unknown addresses, and appends new verified consent evidence with a verification method; existing evidence is never updated. A verification must identify the exact intake choices it confirms and cannot overwrite newer revocation/erasure evidence. Call planning continues to require verified CALL consent.

D4. Abuse protection: add a fail-closed Cloudflare Turnstile CaptchaPort adapter with request timeout. Production requires a real adapter or CAPTCHA_DISABLED_ACKNOWLEDGED=true. Count email/client intake buckets only after CAPTCHA and input validation; retain independent client/IP protection so submitting another person's email cannot exhaust that person's unrelated client bucket. Document privacy, trust-proxy and residual abuse limits.

Add unit/integration coverage, cross-tenant and permission checks for new resources, and preserve the RLS coverage guard. Update README, blueprint scope, Milestone B operations, hardening and API examples. Complete the acceptance checks below and record files, schema, decisions, results, verification limits and a PR description.

## Milestone E: self-hosted production deployment

Target: one Ubuntu 24.04 Docker Compose server, single-tenant pilot. Follow all Working rules above. No frontend, AI screening, job queue, call dispatch, Kubernetes or multi-server HA.

E1. Authenticated TLS SMTP EmailPort, bounded connection/send timeouts, text and HTML verification, PUBLIC_WEB_BASE_URL, production email refusal without explicit disabled acknowledgement; fake SMTP tests.
E2. Version-tagged GHCR releases with SHA-pinned actions, minimal permissions, provenance and SBOM.
E3. Hardened production Compose with Caddy automatic HTTPS as the only published service, exact CORS, one proxy hop, private PostgreSQL/ClamAV/local resume volumes and optional S3 path. Preserve development Compose.
E4. systemd scan and retention timers using one-shot Compose commands and optional failure pings.
E5. Encrypted offsite database, globals and resume backups with retention, scratch restore and row-count drill. Migrations are forward-only: rollback requires restoring a backup.
E6. Secret generation, strict preflight, safe deployment, deployed smoke tests and Ubuntu operations runbook.
E7. Structured JSON logs and request IDs without personal data or query-string secrets.

Validation: existing acceptance plus SMTP/config/preflight tests, production Compose config, shellcheck, production image build and local backup/restore drill when Docker is available. Record verification limits and manual server steps.

## Non-goals for all milestones

AI screening calls, durable job queue, call dispatch, real telephony or calendar providers, candidate portal, payroll, HR self-service.

## Acceptance for every milestone

npm ci; npm run enums:check; npm run lint; npm run format:check; npm run build; migrations apply twice on a fresh DB with the owner role; npm test passes with the app connected as hireai_app; the RLS coverage guard test passes; Docker build if available (otherwise say not run).
