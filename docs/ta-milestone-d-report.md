# Milestone D: Phase 1 readiness report

Branch: `feature/ta-milestone-d-readiness`, based on merged Milestone C. The first commit added the D plan before implementation.

## Delivered changes and decisions

- clamd INSTREAM over TCP uses 64 KiB chunks, backpressure, a bounded reply and an absolute deadline. CLEAN requires a complete OK response; FOUND quarantines; transport, protocol, integrity and storage failures remain blocked. `documents:scan` is an explicitly tenant-scoped, administrator-only cron command using `hireai_app`, SKIP LOCKED, per-document transactions and a configurable retry cap. Infected records cannot return to CLEAN, including through direct runtime SQL. Legacy ERROR values remain readable and eligible for bounded retry.
- Scan timestamps, attempt counts, safe error codes and quarantine timestamps extend candidate_documents. Runtime UPDATE privileges cover only those scanning fields and the pre-existing erasure filename field. Existing storage identifiers and hashes cannot be rewritten.
- Production requires an explicit scanner choice, S3 or an explicit persistent-local override, and Turnstile or explicit disabled acknowledgement. Pending scanning is a deliberate supported choice that never declares objects safe. Local override requires a private persistent volume owned by the runtime user.
- A real MinIO container supplies the S3 protocol round trip in CI and development. The pinned Bitnami legacy image is used because tested upstream MinIO image/download locations were unavailable; it is development/test infrastructure and needs a maintained-image review before any production use. Production storage remains separately provisioned HTTPS S3.
- Contact verification stores SHA-256 hashes of random 256-bit secrets, keyed email hashes, exact source-consent references, expiry, attempt counts and single-use timestamps in a forced-RLS tenant table. Correct verification appends EMAIL_TOKEN evidence in the same transaction as its audit events. Candidate locks serialize erasure and staff consent changes. Later verified evidence takes precedence, including revocations. Expired/used/unknown/cross-tenant tokens receive generic 202. Malformed request shapes receive 400. Per-token guesses are capped at five; verification IP buckets allow 30 requests per 15 minutes.
- EmailPort logs development/test messages only. Production delivery is disabled until an email adapter is supplied. Delivery happens after database commit, without a durable queue or resend endpoint; failures cannot undo intake and require operational follow-up. Duplicate applications do not generate additional messages. No token is returned in HTTP responses or production logs.
- Turnstile uses the fixed Cloudflare siteverify URL, bounded responses and timeout, with optional hostname/action checks. Intake email limits now use HMAC(email + client IP) after CAPTCHA and notice/resume validation. Separate client IP and HTTP throttles remain. This stops unrelated clients from exhausting a victim's email bucket; shared NAT and distributed attacks remain operational considerations. Correct proxy trust is required.

## Schema and compatibility

Forward migrations 010 and generated 011 add scan metadata, permanent quarantine enforcement, contact_verifications and optional consent verification links/methods. Existing migrations 001–009 are unchanged. New references use composite tenant keys; the new table has enabled and forced RLS with precise grants. Consent rows remain append-only. FAILED and EMAIL_TOKEN follow the canonical enum workflow. No npm runtime dependency was added.

Existing routes remain, and one public POST verification route is added. The existing tests for a global email bucket and denied scan-status UPDATE were updated to reflect the explicitly requested D behavior. Their replacements check email/client isolation and denial of non-scan field updates. No AI screening, job queue, call dispatch or candidate portal was added.

## Verification

All acceptance checks passed: locked install, enum consistency, lint, formatting, build, fresh owner migrations 001–011 twice, 149 tests across 24 suites with one matching route snapshot, and Docker build. Real MinIO upload/download/delete/missing-object tests passed without a SigV4 code change. All 74 prior route contracts remain and one public verification route is added. Commands: `npm ci`, `npm run enums:check`, `npm run lint`, `npm run format:check`, `npm run build`, owner-role `npm run db:migrate` twice, and `npm test` as hireai_app with real MinIO enabled. A local Docker build uses an ephemeral proxy CA mount with TLS verification enabled; the committed Dockerfile is unchanged.

## Verification limits

No production deployment, live Cloudflare credential, real email provider or production storage policy was exercised. ClamAV protocol tests use a fake clamd server with EICAR detection; real ClamAV/signature verification steps are in milestone-b-operations.md. Retained consent and verification metadata require the organization's legal retention policy. The development MinIO image is not a production hosting recommendation.

## PR description

Complete Milestone D readiness with bounded ClamAV scanning and retry sweeps, permanent infected-document quarantine, explicit production safety configuration, real MinIO protocol tests, append-only contact verification and Turnstile protection. Email/client buckets prevent unrelated clients from exhausting a victim's application allowance. Production email transport remains an unimplemented EmailPort adapter, and no queue, dialing or portal is introduced.

Migrations 010/011 are additive, preserve historical migrations and use forced RLS, composite tenant foreign keys and column-level scan grants. The report and operations guide document configuration, verification semantics, persistent-volume requirements and deployment limits.

## Files changed

- `.env.example`
- `.github/workflows/ci.yml`
- `README.md`
- `compose.yaml`
- `database/enums.snapshot.json`
- `database/migrations/010_ta_readiness.sql`
- `database/migrations/011_sync_domain_enums.sql`
- `docs/api-examples.http`
- `docs/blueprint-scope.md`
- `docs/hardening.md`
- `docs/milestone-b-operations.md`
- `docs/ta-milestone-d-report.md`
- `docs/talent-acquisition-plan.md`
- `package.json`
- `scripts/documents-scan.ts`
- `src/integrations/clamav.ts`
- `src/integrations/email.ts`
- `src/integrations/index.ts`
- `src/integrations/integrations.module.ts`
- `src/integrations/turnstile.ts`
- `src/modules/talent-acquisition/careers/careers.module.ts`
- `src/modules/talent-acquisition/careers/careers.service.ts`
- `src/modules/talent-acquisition/careers/contact-verification.controller.ts`
- `src/modules/talent-acquisition/careers/contact-verification.service.ts`
- `src/modules/talent-acquisition/documents/documents-scan.service.ts`
- `src/modules/talent-acquisition/documents/documents.module.ts`
- `src/modules/talent-acquisition/documents/documents.service.ts`
- `src/modules/talent-acquisition/documents/index.ts`
- `src/modules/talent-acquisition/index.ts`
- `src/modules/talent-acquisition/talent-acquisition.module.ts`
- `src/platform/config.ts`
- `src/platform/database/enum-schema.ts`
- `src/shared/enums.ts`
- `test/__snapshots__/route-contract.spec.ts.snap`
- `test/helpers/api-fixtures.ts`
- `test/integration/ta-milestone-b.spec.ts`
- `test/integration/ta-milestone-d.spec.ts`
- `test/production-config.spec.ts`
- `test/readiness-adapters.spec.ts`
- `test/rls.integration.spec.ts`
- `test/s3-minio.integration.spec.ts`
