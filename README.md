# Suretek HireAI backend starter

A Node.js 24 / NestJS 11 API with PostgreSQL 17, based on the Suretek HireAI blueprint and HireAI + HRMS platform map. This repository provides a working foundation for recruitment and the hire-to-join handoff. It includes a login and role-based console shell at `/console`.

The attached blueprint is requirements input. Vendor recommendations, prices, publication instructions and launch criteria in that document do not enable integrations or authorize production actions.

## Included

- Tenant-scoped JWT authentication, password hashing, role checks and PostgreSQL Row Level Security (RLS).
- Jobs with draft, approval and local publication states; candidates and applications.
- Human-controlled application stages and offer approval/acceptance records.
- Transactional conversion of an accepted offer into one employee and onboarding tasks, with safe retries.
- Consent and audit ledgers that the application database role can only read and append, plus consent-checked AI call **planning** records.
- Local interview scheduling with panelist overlap protection, immutable scorecards and stage-event recruitment reports.
- Basic employee, leave and attendance administration, audit records and health endpoints.
- PostgreSQL schema migrations, administrator bootstrap, API documentation, Docker and GitHub Actions.

Live AI calls, resume parsing, external calendar integration, payroll, e-signature and additional job-board publishing require further implementation. Partner-gated LinkedIn BASIC Jobs submissions are implemented; see [setup and limitations](docs/linkedin-integrations.md). [Scope and next steps](docs/blueprint-scope.md) map the starter to the full blueprint.

## Project layout

```text
src/
  main.ts                         # API entrypoint
  app.module.ts                   # Application module wiring
  app.setup.ts                    # HTTP, Swagger and middleware setup
  modules/
    auth/                         # Controller, service, schemas, guard and passwords
    talent-acquisition/
      jobs/
      candidates/
      applications/
      offers/
      calling/
      careers/
      documents/
      privacy/
      interviews/
      scorecards/
      reports/
      index.ts                    # Public recruitment module API
    hr/
      employees/
      onboarding/
      leave/
      attendance/
      hr-provisioning.service.ts  # Transactional hire-to-join handoff
      index.ts                    # Public HR module and provisioner API
  platform/
    config.ts                     # Environment configuration
    database/                     # Pool, tenant context and enum schema mapping
    http/                         # HTTP helpers and health/report controllers/services
    audit/                        # Transactional audit helper
  shared/                         # Actor, enums and authorization contracts
  integrations/                   # Future provider adapters
database/                         # Immutable migrations, enum snapshot and role setup
scripts/                          # Migrations, bootstrap and enum generation CLIs
test/                             # API, database and contract verification
```

Each business feature keeps its controller, schemas and service together. Authentication separates request handling and validation from its service and guard. Health and reporting controllers delegate to platform services. Platform code supplies database, tenant-context, HTTP and audit infrastructure; shared contracts contain `Actor`, enums, role decorators and explicit permission groups.

Import another module through its public `index.ts` barrel rather than its internal controllers or services. The offers feature uses HR's exported `HrProvisioningService` for employee and onboarding creation inside the existing hire transaction. HR controllers retain their original Swagger operation IDs when split into features, preserving the API documentation contract.

## Run locally

Install Node.js 24, npm and Docker with Compose. Start Docker Desktop on Windows and wait for its engine to be ready; `docker version` should show both Client and Server. Run the commands from the project directory. Each command below is a separate step, so PowerShell does not need `&&`.

If you already have a database from an earlier starter, follow the [existing-database upgrade](docs/hardening.md#upgrade-an-existing-database) before migrating. Keep its volume and data.

Copy the example configuration using the command for your shell, then install dependencies:

```bash
cp .env.example .env
npm ci
```

```powershell
Copy-Item .env.example .env
npm ci
```

Edit `.env`: replace `JWT_SECRET` with a random value of at least 32 characters, set `BOOTSTRAP_ADMIN_PASSWORD` to a unique password of at least 12 characters, and set a new `BOOTSTRAP_TENANT_ID`. Generate the secret and tenant UUID once:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
node -e "console.log(require('node:crypto').randomUUID())"
```

Save the UUID in `.env` and reuse it for bootstrap retries. Tenant names are display labels and do not identify an existing tenant. If you leave the UUID empty, bootstrap generates a new tenant ID on every invocation; save the printed ID before retrying. Replace the password placeholders in `POSTGRES_ADMIN_PASSWORD`, `HIREAI_OWNER_PASSWORD`, `HIREAI_APP_PASSWORD` and the matching URLs. Check that `DATABASE_URL` uses `hireai_app` and `DATABASE_MIGRATION_URL` uses `hireai_owner`. Use URL-safe passwords with this Compose configuration, such as values generated by the `base64url` command above.

For a new database, start PostgreSQL, apply migrations with the owner role, then create the dedicated SaaS platform owner:

```bash
docker compose up -d postgres
npm run db:migrate
npm run bootstrap:platform
npm run dev
```

Remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env` after bootstrap succeeds. Rerunning bootstrap for an existing admin retains its saved password; editing this env variable does not reset it. For local sign-in failures, run `npm run auth:check` from the project root; see [console troubleshooting](web/README.md#diagnose-invalid-credentials-locally). Login requires `tenantId`, `email` and `password`; protected business routes derive the tenant from the verified token. Bootstrap runs as the owner, sets its tenant context before accessing data, and does not overwrite an existing password. For SaaS use bootstrap:platform with a dedicated platform tenant and organization key platform; see [SaaS onboarding](docs/saas-onboarding.md). To add another administrator, use that tenant's saved UUID and a different admin email.

- API: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/docs` when enabled; disabled by default in production
- Liveness: `http://localhost:3000/api/v1/health/live`
- Database readiness: `http://localhost:3000/api/v1/health/ready`

Use [api-examples.http](docs/api-examples.http) with a REST client or copy its JSON into Swagger. After login, click **Authorize** in Swagger and supply the access token. Access tokens expire; login again to obtain a fresh token. Refresh tokens and external SSO are future work.

## Main workflow

1. Create a job; an HR administrator approves it; publish it to the application's internal job listing.
2. Create a candidate and application; a recruiter manually shortlists the application.
3. Record consent evidence. Optionally enable call planning and create a planning record during the configured calling window. No call is dialed.
4. Schedule an interview locally and collect immutable panelist scorecards. Staff retain control of application stages and hiring decisions.
5. Prepare and approve an offer. An HR administrator records acceptance with an evidence reference.
6. Convert the accepted offer to an employee. Retrying the same conversion returns the existing employee; it does not create another employee or duplicate onboarding tasks.

`PUBLISHED` is an internal database state; it does not automatically publish a vacancy to a careers CMS or LinkedIn. LinkedIn Jobs publishing is a separate, partner-gated action. Offer acceptance records an HR user's attestation; this starter has no candidate acceptance portal or e-signature verification.

## Access and data model

Organization business access remains within the authenticated user's tenant. `SUPER_ADMIN` has only the isolated SaaS organization control plane and no business-data access. Roles in the platform map are represented in the database, but only implemented staff routes grant access. Candidate self-service, employee self-service and interviewer assignments must be implemented before exposing those portals. Role names alone do not grant record ownership access.

| API area                                                               | Allowed roles                        |
| ---------------------------------------------------------------------- | ------------------------------------ |
| Current user                                                           | Any active authenticated user        |
| Jobs, candidates, applications, consent, call plans and hiring summary | Organization Admin, Recruiter        |
| Job approval                                                           | Organization Admin                   |
| Offers, employees, onboarding, leave, attendance and audit             | Organization Admin                   |
| User creation and activation                                           | Organization Admin; staff roles only |

Each protected request rechecks the active user. Business queries retain their tenant filters, composite foreign keys preserve tenant boundaries, and PostgreSQL enforces forced RLS on `tenants` and every table with `tenant_id`. With no tenant context, reads return zero tenant rows. Mutations and their audit events commit in the same transaction. Database constraints prevent duplicate applications and duplicate employee conversions. Money is accepted as a decimal string to avoid floating-point rounding.

Request middleware starts an `AsyncLocalStorage` store. Login sets its validated tenant ID before the user query; authenticated requests set it from the verified token before the active-user lookup. `DbService` uses a checked-out connection and transaction-local `set_config` for queries and transactions, so context is cleared before the connection returns to the pool. See [hardening design and checks](docs/hardening.md).

Consent is separate for calling, recording and transcription. Revoking consent cancels affected pending planning records. `CALL_PLANNING_ENABLED=false` disables new call plans; the configured timezone and end-exclusive daily window are checked when creating a new plan. Planning records are never dispatched by this repository. A future worker must recheck all policy, consent, eligibility and emergency-stop conditions immediately before any external call.

## Database changes

Add new numbered SQL files in `database/migrations/`; never edit a migration already applied to an environment. The runner uses a database advisory lock and records checksums, so repeated runs are safe and altered migration history is rejected.

```bash
npm run db:migrate
```

Database credentials have separate responsibilities in local development, Docker and CI:

| Setting / role                            | Purpose                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `DATABASE_URL` / `hireai_app`             | API runtime only; non-owner, `NOSUPERUSER`, `NOBYPASSRLS`, no DDL, and only the table operations used by the API         |
| `DATABASE_MIGRATION_URL` / `hireai_owner` | Schema ownership, migrations and bootstrap; keep these credentials out of the API container                              |
| `TEST_ADMIN_DATABASE_URL`                 | Dedicated test-database administrator for fixture creation, cleanup and direct verification; never a production database |

The Compose initialization script provisions roles and the database only for a fresh named volume. Migration `003_row_level_security.sql` enables and forces RLS, and grants runtime privileges when `hireai_app` exists. It grants only `SELECT` and `INSERT` on `consents` and `audit_events`. Applied migrations `001` and `002` remain unchanged. Provision roles before migrating; [existing databases need an ownership transfer](docs/hardening.md#upgrade-an-existing-database).

In production, `DATABASE_MIGRATION_URL` is required for migration/bootstrap commands. Development and test allow a fallback to `DATABASE_URL`; use the owner URL even there. The API refuses to start in production with a superuser, a role that bypasses RLS, or an owner of tenant tables, and warns in development/test. Set `PGSSLMODE=require` for a hosted database that requires TLS and configure the appropriate CA trust; certificate verification stays enabled.

| Runtime setting   | Behavior                                                                                                                                                                                                         |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SWAGGER_ENABLED` | `true` or `false`; defaults to `false` in production and `true` elsewhere. Disabled `/docs` returns 404.                                                                                                         |
| `TRUST_PROXY`     | `false` by default, or a nonnegative number of proxy hops. For one known reverse proxy, use `1` and restrict direct access to the API. This makes `request.ip` and login throttling use the forwarded client IP. |

Use HTTPS, restrict database access, and configure backups and restore testing for a hosted deployment. The context variable is an application-supplied boundary, not a cryptographic binding to a user: protect runtime credentials and preserve authentication/authorization checks.

## Shared enums

Define role, status, stage, consent, language and leave values in [`src/shared/enums.ts`](src/shared/enums.ts). Application code and validation import these enums; PostgreSQL stores the same strings and validates them with generated `CHECK` constraints.

After changing an enum, generate and apply its database migration:

```bash
npm run enums:generate
npm run enums:check
npm run db:migrate
```

Commit the enum change, generated SQL migration and `database/enums.snapshot.json`. New roles receive no business permissions until you deliberately add them to the grants in `src/shared/role-groups.ts`; they can read their own authenticated profile. Renaming or removing stored values requires a deliberate data migration. The generator never rewrites existing rows. See [enum usage and upgrades](docs/enums.md).

If you already run an earlier starter version, keep your `.env` and database, follow the [ownership and RLS upgrade](docs/hardening.md#upgrade-an-existing-database), install dependencies with `npm ci`, then run `npm run db:migrate`. No database reset or repeat bootstrap is needed.

## Verify changes

Run the suite against a dedicated test database. `DATABASE_URL` must connect as `hireai_app`; `DATABASE_MIGRATION_URL` must connect as the owner; `TEST_ADMIN_DATABASE_URL` must connect as a separate administrator that can create and remove fixtures despite RLS. Tests reject an unsafe runtime role. See [local test setup and acceptance commands](docs/hardening.md#verification).

```bash
npm run enums:check
npm run lint
npm run format:check
npm run build
npm test
```

The GitHub Actions workflow provisions separate PostgreSQL owner/app roles, installs from the lockfile, checks enum migrations, formatting and lint, compiles the API, applies migrations twice as the owner, and tests with the app role plus a separate admin fixture connection. A separate job builds the Docker image without pushing it. CI credentials are disposable fixtures and need no GitHub secrets. Dependabot excludes major `@nestjs/*` upgrades to preserve the CommonJS setup.

## Run the API in Docker

The optional `app` Compose profile builds the API and a one-shot migration service. Its API uses `NODE_ENV=production`, so before starting it configure `RESUME_STORAGE=s3`, an HTTPS `S3_ENDPOINT`, private `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`. Set `S3_SESSION_TOKEN` only for temporary credentials; an empty value is treated as omitted. Provision the bucket to deny public access. Localhost `npm run dev` can continue using private local resume storage.

Compose forwards the storage settings, intake limits, retention period and offer maker-checker setting explicitly, alongside JWT/calling settings. Configure `.env` first as above. If you already bootstrapped the same database locally, skip bootstrap and keep using that tenant ID.

```bash
docker compose up -d postgres
docker compose --profile app build
docker compose --profile app run --rm migrate
docker compose --profile app run --rm migrate node dist/scripts/bootstrap.js
docker compose --profile app up -d api
```

The migration container receives owner credentials; the API container receives only the app connection URL. Starting the API also waits for the migration service to finish successfully. The image runs as an unprivileged user. PostgreSQL and the API bind only to localhost in this development Compose file, and Swagger is disabled by the production default. Data persists in a named Docker volume. Use a secret manager, HTTPS reverse proxy and managed database/network configuration for hosting.

## Upload to GitHub

Create an empty GitHub repository, then run these commands from the extracted project folder, replacing the remote URL:

```bash
git init
git add .
git commit -m "Initialize Suretek HireAI backend"
git branch -M main
git remote add origin https://github.com/YOUR-ACCOUNT/suretek-hireai-backend.git
git push -u origin main
```

`.env`, dependencies and build output are ignored. Commit `package-lock.json` and all migrations. In GitHub repository settings, protect `main` and require the **Lint, build and PostgreSQL integration tests** check. Add deployment workflows and environment secrets only after choosing a hosting target. No software license has been chosen; add the license your organization intends to use before public distribution.

## Talent Acquisition milestone A

Core job requirements, scoped assignments, append-only application history, revised offers and searchable lists are implemented. See [the roadmap](docs/talent-acquisition-plan.md) for A/B/C scope and [API examples](docs/api-examples.http) for requests.

Jobs accept optional `openings`, `employmentType` (FULL_TIME/PART_TIME/CONTRACT/INTERN), nullable numeric `salaryMin`/`salaryMax`, `hiringManagerUserId`, `screeningCriteria` (`id`, `label`, positive `weight` up to 100, `must_have`) and `closeReason`. Existing location is retained. Close accepts an optional `closeReason` and records `closed_at`. The manager field is descriptive; access always requires an explicit assignment.

Admins manage job assignments with POST/GET `/api/v1/jobs/:id/assignments` and DELETE `/api/v1/jobs/:id/assignments/:assignmentId`. Assignment roles are HIRING_MANAGER, INTERVIEWER and RECRUITER_OWNER; the user must have the matching active global role (RECRUITER for RECRUITER_OWNER). Managers/interviewers can read only assigned jobs/applications. Assigned managers can shortlist/reject; rejection requires `reasonCode` (QUALIFICATIONS/EXPERIENCE/COMPENSATION/OTHER). Recruiter/admin access is unchanged. GET `/api/v1/applications/:id/history` returns evidence, including offer/hire transitions.

Jobs, candidates and applications support `jobId`, `stage`, `status` (job status), `createdFrom`/`createdTo` (inclusive ISO timestamps), `q`, `sort` (created_at/updated_at), `direction` (asc/desc), `limit` and `offset`. Candidate job/stage/status filters must match the same application. Job text search uses title/description; candidate/application text search uses candidate name/email. Responses retain `{data,pagination:{limit,offset}}` and add `total`, including empty pages. Text search uses parameterized ILIKE with SQL wildcard semantics; no extension or superuser permission is required. Leading-wildcard search can scan large tenant datasets; trigram indexing is deferred pending deployment extension review.

Offers accept `expiresAt` and can be closed through POST `/api/v1/offers/:id/decline`, `/withdraw`, or `/expire`. DRAFT/APPROVED/ACCEPTED count as active; a partial index permits one per application. Revisions are new rows after DECLINED/WITHDRAWN/EXPIRED; an OFFER-stage application can receive the revision without a duplicate stage event. Expired pending offers block approval/acceptance and become EXPIRED explicitly through `/expire` or lazily when a replacement is created. There is no scheduler. ACCEPTED offers remain active and hireable after the offer expiry timestamp. `OFFER_MAKER_CHECKER` requires a different approver when enabled (default true in production, false elsewhere).

## Talent Acquisition milestone B

Public careers, intake evidence, private resumes and candidate erasure/retention are implemented. Interviews, scorecards and reports are described under Milestone C below. No AI, queue, telephony or external calendar provider is called. See [Milestone B operations](docs/milestone-b-operations.md) for configuration and recovery details.

Public routes are GET `/api/v1/public/:tenantSlug/jobs`, GET `/api/v1/public/:tenantSlug/jobs/:id`, and POST `/api/v1/public/:tenantSlug/jobs/:id/applications`. Only published jobs and explicitly selected public fields are exposed. Default slugs are `tenant-<UUID>`; set `BOOTSTRAP_TENANT_SLUG` when bootstrapping or rerunning bootstrap for a known tenant ID to configure a friendly slug. Staff-only tenant rows retain forced RLS. A restricted, fixed-search-path SECURITY DEFINER function reads only the derived public slug/ID directory; the runtime cannot read that directory directly.

Intake accepts `fullName`, `email`, optional E.164 `phone`, `noticeVersion`, separate `consents` booleans (CALL, RECORDING, TRANSCRIPTION; each defaults false), an empty `website` honeypot and optional `captchaToken`. CAPTCHA is explicitly disabled through its stub. Responses are always the same 202 message for new or duplicate candidate/application submissions. Existing PII is never overwritten, and repeated applications create no duplicate evidence. Per-tenant IP/email limits are persisted in PostgreSQL, in addition to public per-IP route throttling. Consent evidence includes notice version, timestamp, IP and HMAC user-agent hash. Anonymous consent is self-reported and unverified; call planning still requires staff-verified evidence.

An optional public `resume` object contains `filename` and `base64` (up to 512 KiB, also constrained by `RESUME_MAX_BYTES`). Staff upload larger resumes with multipart POST `/api/v1/candidates/:id/documents` (`file`, default 5 MiB, hard ceiling 10 MiB), list with GET on the same route, and download through GET `/api/v1/candidates/:id/documents/:documentId/download`. Only recruiter/admin roles have document access. PDF/DOCX extensions must match magic bytes; DOCX must be a bounded OOXML package. Names are sanitized and SHA-256 is stored. The scanner stub returns PENDING, so downloads remain blocked until a real adapter returns CLEAN; no unsafe bypass switch is provided. Downloads are authorized, audited, integrity checked and streamed as attachments.

Local storage is private and for development/test only. Production startup requires `RESUME_STORAGE=s3` with an HTTPS endpoint, private bucket, region and credentials. S3 requests use SigV4; the bucket must deny public access. No public URLs are produced.

Admins erase a candidate with POST `/api/v1/candidates/:id/erase`. This anonymizes candidate PII, revokes consent, cancels pending call plans and deletes resumes while preserving consent/audit evidence. The response includes `documentsPending`: zero means storage deletion completed. Failures remain inaccessible and are retried by the same endpoint or retention command. Separate HR employee records follow their own policy.

After `npm run build`, run `npm run retention -- --tenant-id <UUID> --actor-id <ADMIN_UUID> --dry-run` to preview, then omit `--dry-run` to execute. The command requires the `hireai_app` connection and an active administrator in the selected tenant; `--limit` is 1–1000 (default 100). The default period is 365 days. Recent activity, active applications and employee-linked candidates are excluded from automatic retention. Validate retention, consent and evidence-preservation requirements with counsel before production use.

## Talent Acquisition milestone C

Local interviews, panelist scorecards and recruitment reports are implemented. Interview times are stored as instants; panelist reservations use half-open intervals, allowing adjacent interviews while rejecting overlaps. The calendar adapter is a stub and creates no external event, invitation or meeting link. Scorecards use the screening criteria captured when the interview was scheduled, require the signed-in author to be an actual panelist, and are immutable after submission. A recommendation never changes an application stage or makes a hiring decision.

Recruiter/admin reports are GET `/api/v1/reports/recruitment/funnel`, `/time-in-stage` and `/time-to-hire`. Each accepts only optional `jobId`, `from` and `to`. Timestamps require a timezone; periods are `[from,to)`, positive and at most 366 days. The default period is the 30 days ending now. An unknown or foreign-tenant job returns 404. Future end times are observed only through the response's `asOf` instant.

- Funnel counts distinct applications entering each stage during the period, grouped by job and stage.
- Time in stage follows chronological stage events, clips each visit to the period, excludes terminal HIRED/REJECTED dwell, and averages over positive-duration visits. Returning to a stage creates another visit.
- Time to hire uses the first APPLIED and first HIRED events, with hiring in the period. Missing initial APPLIED evidence and reversed histories are excluded and counted separately; no zero-duration estimate is invented for legacy rows.

Responses include `period`, `asOf` and `data`; durations are seconds. Empty groups are omitted. Migration 004 backfilled the then-current stage at `application.created_at`, so pre-Milestone-A dwell is reconstructed rather than recovered transition timing. The 366-day period bounds the report window; dwell and hire calculations can still scan full tenant history. Profile larger datasets before expanding analytics. The earlier `/reports/hiring-summary` endpoint is unchanged. See [Milestone C details and verification](docs/ta-milestone-c-report.md) and the [API examples](docs/api-examples.http).

## Milestone D readiness

ClamAV scanning and a bounded cron sweep, permanent infected-document quarantine, explicit production storage/scanner/CAPTCHA choices, real MinIO protocol tests, hashed single-use contact verification and Turnstile are implemented. See [readiness operations](docs/milestone-b-operations.md#milestone-d-readiness) for configuration, local-volume persistence, verification limitations and real ClamAV checks. Milestone E adds authenticated TLS SMTP and the single-server production runbook in [deploy/README.md](deploy/README.md). Email/client rate buckets are charged after validation and CAPTCHA, preventing unrelated clients from exhausting a victim's email allowance.

## Milestone E: single-server deployment

See [the production runbook](deploy/README.md) for Ubuntu 24.04, versioned GHCR releases, Caddy HTTPS, private persistent local resumes, systemd maintenance, encrypted offsite backups and scratch restore drills. Migrations are forward-only; rollback requires restoring a backup. Production email requires SMTP or EMAIL_DISABLED_ACKNOWLEDGED=true; the pilot preflight requires real SMTP and CAPTCHA. Verification links use a fragment at PUBLIC_WEB_BASE_URL; the verification web client is outside this backend milestone. JSON request logs omit URLs, bodies and personal data. No schema or API contract changes.

## F1 console

The React console is served at `/console` on the API origin. See [console operations](web/README.md) for development, test users and deployment. Browser authentication uses HttpOnly cookies with exact Origin CSRF checks; existing bearer clients remain supported. Password reset and refresh are not provided. Role homes are placeholders only.

## SaaS organizations and staff invitations

The user-requested SaaS extension replaces the single-tenant console model. SUPER_ADMIN manages organizations and initial admin invitations only; HR_ADMIN is Organization Admin and manages that organization's staff/business access. Apply migration 012 and bootstrap a dedicated platform owner with npm run bootstrap:platform. Existing business tenants are never automatically promoted. Recipients follow a one-time email link to set their password, then sign in using their organization key. One frontend build supports every organization; VITE_TENANT_ID/PILOT_TENANT_ID are no longer used. Configure authenticated TLS SMTP and PUBLIC_WEB_BASE_URL before inviting customers. See [setup, upgrade, APIs and permissions](docs/saas-onboarding.md) and [console operations](web/README.md).

## Super Admin platform module

The platform owner console provides Dashboard, Organizations, Integrations, Settings, Audit Logs and Platform Reports. Super Admins manage governance and aggregate usage without access to tenant candidate/employee records.

Apply migrations with `npm run db:migrate`, set `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_INITIAL_PASSWORD` and a stable `BOOTSTRAP_TENANT_ID`, then run `npm run bootstrap:platform`. Sign in at `/console/login` using organization `platform`; new owners must change their initial password. Configure `INTEGRATION_ENCRYPTION_KEY` before saving provider credentials and existing SMTP settings before inviting organization admins.

See [Super Admin operations](docs/super-admin.md) for organization onboarding, migration compatibility, all new environment variables, module/menu extensions, security boundaries and explicit optional TODOs. The [repository audit](docs/super-admin-audit.md) documents the original architecture.

The latest completion review fixes sandbox approval invalidation, suspended/deleted invitation handling, anonymous unresolved-login audits, password-policy enforcement and console validation/filtering. Apply forward-only migration **016** before starting the updated API. No new environment variables or dependencies were added in this review. See [verification and server checklist](docs/super-admin-verification.md) for commands, results and deployment steps.

### Organization-owned provider connections

Super Admin enables providers under Integrations → Available to organizations. Organization Admins then connect their own accounts under Integrations using the provider's supported API key, OAuth, token, basic-auth or SMTP method. Apply migration 017 and configure the stable integration encryption key first. See [setup, methods and OAuth callback registration](docs/super-admin.md#organization-owned-integrations-migration-017).

If Super Admin APIs return 404, rebuild/restart the backend from this branch and run `npm run api:check`; the registered protected routes return 401 without credentials. See [API/proxy troubleshooting](docs/super-admin.md#diagnosing-apiv1super-admin-404s).

Hosted calendar authorization and partner-gated LinkedIn Jobs publishing are documented in [LinkedIn integrations](docs/linkedin-integrations.md). Apply migrations through 020 before deploying these changes.
