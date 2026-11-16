# PostgreSQL isolation and production settings

This change adds database enforcement to the existing tenant filters and role checks. It does not add recruitment features, change the persisted enum strings, or convert PostgreSQL columns to native enum types.

## Request and database boundaries

An Express middleware runs each request inside a fresh mutable `AsyncLocalStorage` store containing an optional `tenantId`. The authentication guard writes the verified token's tenant claim into that store before looking up the active user. Login writes the validated body tenant ID before looking up credentials. This lets the same context reach later handlers and database operations without relying on `enterWith` inside a guard.

`DbService.query` / `one` use a dedicated checked-out client and transaction when a tenant is present: `BEGIN`, parameterized `set_config('app.tenant_id', tenantId, true)`, the query, then `COMMIT` or `ROLLBACK`. `DbService.transaction` sets the context immediately after `BEGIN` and passes that same client to its callback. The setting is transaction-local; returning a connection to the pool cannot retain a tenant from a completed transaction. Code without a request context has no tenant access. Background work must explicitly establish its tenant context before using tenant data.

Migration `003_row_level_security.sql` discovers tenant tables from the catalog, enables and forces RLS on each `tenant_id` column, and applies the corresponding policy to `tenants.id`:

```sql
USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
```

Without context, the expression evaluates to unknown and reads return zero rows. An insert into another tenant fails. Existing `WHERE tenant_id = ...` filters, composite tenant foreign keys and authorization checks remain in place. Readiness checks connectivity using `SELECT 1`; it does not require tenant visibility.

`hireai_owner` owns the database, schema and migrated objects and runs migrations/bootstrap. `hireai_app` is a separate login with `NOSUPERUSER`, `NOBYPASSRLS` and no ownership or DDL rights. Its grants reflect the API's actual reads/inserts/updates. On `consents` and `audit_events` it has only `SELECT` and `INSERT`, so the API cannot update or delete those ledgers. Infrastructure provisions the roles; migration `003` grants to `hireai_app` if it exists and otherwise emits a notice.

The API checks the connected role at startup. Production refuses superuser, `BYPASSRLS`, and tenant-table-owner connections. Development and test warn so configuration mistakes are visible. Owner credentials belong only in provisioning/migration processes. A role that can supply arbitrary SQL and tenant settings can choose a different context; RLS protects against missing query filters, while authentication and secret protection remain necessary.

## Fresh database

Use the [README setup](../README.md#run-locally). The Postgres initialization script runs only when the data directory is empty. It creates `hireai_owner`, `hireai_app` and `hireai`. The optional `migrate` Compose service applies migrations using the owner; `api` uses only the app role and waits for migrations.

Set `DATABASE_URL` to the app URL and `DATABASE_MIGRATION_URL` to the owner URL. In production the latter is mandatory for migrations/bootstrap. A development/test fallback exists for compatibility, but an app-role URL cannot create or alter the schema.

Generate `BOOTSTRAP_TENANT_ID` once with `node -e "console.log(require('node:crypto').randomUUID())"` and save it in `.env` before the first bootstrap. Bootstrap uses the owner connection, sets that UUID as transaction-local context before any tenant access, and creates the tenant/admin if absent. Reuse the UUID for retries; an existing admin email is left unchanged. If the ID is omitted, bootstrap generates and prints a new UUID; save it and supply it on retries. A repeated invocation without an ID intentionally creates a different tenant, even when its name is unchanged. There is no global tenant-name lookup under forced RLS.

## Upgrade an existing database

Keep the existing named volume. Changing `POSTGRES_USER` or passwords in Compose does not change roles or credentials already stored in that volume, and mounting an initialization script does not rerun it. The old starter used the existing administrator `hireai`; its cluster may have no `postgres` login. Use the administrator that actually exists.

Stop the API before changing ownership, and take a backup using the existing administrator. These commands use the old starter's `hireai` role/database; substitute your actual names. Writing the dump inside the container and copying it avoids binary redirection differences in Windows PowerShell:

```bash
docker compose stop api
docker compose up -d postgres
docker compose exec postgres pg_dump -U hireai -d hireai -Fc -f /tmp/hireai-before-rls.dump
docker compose cp postgres:/tmp/hireai-before-rls.dump ../hireai-before-rls.dump
```

Keep the backup outside the repository and confirm it can be restored into a separate database before a production upgrade. Do not remove the volume or initialize a replacement database as an upgrade step.

Open `psql` as the existing administrator:

```bash
docker compose exec postgres psql -U hireai -d hireai -v ON_ERROR_STOP=1
```

Run this SQL for the starter's database. Role creation is safe to retry. The password commands prompt for values; enter the passwords you will configure in the owner/app URLs and Compose password variables.

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireai_owner') THEN
    CREATE ROLE hireai_owner LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireai_app') THEN
    CREATE ROLE hireai_app LOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER ROLE hireai_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
ALTER ROLE hireai_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
REVOKE hireai_owner FROM hireai_app;
\password hireai_owner
\password hireai_app

ALTER DATABASE hireai OWNER TO hireai_owner;
REVOKE ALL ON DATABASE hireai FROM PUBLIC;
REVOKE ALL ON DATABASE hireai FROM hireai_app;
GRANT CONNECT ON DATABASE hireai TO hireai_owner, hireai_app;
ALTER SCHEMA public OWNER TO hireai_owner;
REVOKE ALL ON SCHEMA public FROM PUBLIC;

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('ALTER TABLE %I.%I OWNER TO hireai_owner', item.nspname, item.relname);
  END LOOP;
  FOR item IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'S'
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO hireai_owner', item.nspname, item.relname);
  END LOOP;
END $$;
\q
```

This transfers the starter's existing tables, including `schema_migrations`, and sequences; table ownership also carries indexes and constraints. If your database has additional schemas, views, functions or extension objects, inventory them separately before transferring their ownership. Avoid a blanket `REASSIGN OWNED` from the original initialization superuser, which can affect shared objects beyond this project database.

Update `.env` without discarding the JWT secret or tenant IDs:

- `DATABASE_URL`: `hireai_app` connection to the existing `hireai` database.
- `DATABASE_MIGRATION_URL`: `hireai_owner` connection to that same database.
- `HIREAI_OWNER_PASSWORD` and `HIREAI_APP_PASSWORD`: the matching role passwords for Compose. Use URL-safe values with the supplied Compose URLs.
- `BOOTSTRAP_TENANT_ID`: the existing tenant UUID if you ever need bootstrap again; this upgrade does not require bootstrap.

Then, from the project directory:

```bash
npm ci
npm run enums:check
npm run db:migrate
npm run db:migrate
npm run dev
```

The second migration run should report every file as already applied. The runner checks historical checksums; do not edit `001_initial.sql` or `002_sync_domain_enums.sql`. Resume the containerized API with the Docker steps in the README if that is how you run it.

## Production settings

`SWAGGER_ENABLED` accepts `true` or `false`. When omitted, it is true in development/test and false in production. Disabled Swagger routes, including `/docs`, are not registered and return 404.

`TRUST_PROXY=false` is the default. Use an integer hop count only for your actual proxy path; for example, `1` for one trusted ingress with direct API access blocked. Express then derives `request.ip` from that path, which also gives the throttler the intended client IP. The configuration does not accept an unbounded `true` setting. Deployments with varying proxy paths need an explicitly reviewed ingress configuration.

Use separate credentials for the runtime API and owner/migration processes. Do not pass the migration URL to a production API. Compose whitelists API environment variables rather than importing the whole `.env`. Configure TLS/CA trust and rotate the local development passwords when deploying.

## Verification

Use a disposable database that is separate from your development tenant records and production. Fixture setup and cleanup require `TEST_ADMIN_DATABASE_URL`; the application under test must use `hireai_app`, not the administrator or owner. The owner applies migrations first. The default GitHub Actions service administrator is used only to provision roles and fixtures; tests exercise the restricted app role.

For a fresh Compose cluster, create the dedicated test database using its provisioning administrator:

```bash
docker compose exec postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE hireai_test OWNER hireai_owner"
```

This `postgres` administrator example applies only to a newly initialized hardening Compose volume. On an upgraded volume, use the existing administrator, such as `hireai`. After creating the test database, revoke public access and allow the runtime role to connect:

```bash
docker compose exec postgres psql -U postgres -d hireai_test -v ON_ERROR_STOP=1 -c "REVOKE ALL ON DATABASE hireai_test FROM PUBLIC; GRANT CONNECT ON DATABASE hireai_test TO hireai_owner, hireai_app"
```

In a separate terminal, point the three URLs at `hireai_test`. For PowerShell, replace `YOUR_APP_PASSWORD`, `YOUR_OWNER_PASSWORD` and `YOUR_ADMIN_PASSWORD` below with your configured URL-safe values:

```powershell
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgresql://hireai_app:YOUR_APP_PASSWORD@localhost:5432/hireai_test'
$env:DATABASE_MIGRATION_URL = 'postgresql://hireai_owner:YOUR_OWNER_PASSWORD@localhost:5432/hireai_test'
$env:TEST_ADMIN_DATABASE_URL = 'postgresql://postgres:YOUR_ADMIN_PASSWORD@localhost:5432/hireai_test'
npm ci
npm run enums:check
npm run lint
npm run format:check
npm run build
npm run db:migrate
npm run db:migrate
npm test
docker build -t suretek-hireai-backend:hardening .
```

For Bash, replace the four `$env:` assignments with `export NODE_ENV=test` and `export VARIABLE='value'` for each URL. Use the passwords and existing admin role that actually belong to your test cluster. Keep the test terminal separate so subsequent API commands do not accidentally connect to the test database.

The suite covers missing-context reads across tenant tables, deliberately unfiltered tenant-scoped reads, cross-tenant writes and API access, denied ledger updates/deletes, denied DDL, pool context isolation, production-role startup checks, Swagger defaults and proxy configuration, alongside the existing hiring/consent tests. CI also builds the Docker image with `push: false` using a pinned action. Commands and results for a particular change belong in its PR report; the documentation does not substitute for running them.

To check the fail-closed behavior directly, connect as `hireai_app` without setting `app.tenant_id` and run:

```sql
SELECT current_user;
SELECT count(*) FROM candidates;
```

The count must be `0`, including when an administrator can verify that tenant rows exist. For a scoped diagnostic, begin a transaction, run `SELECT set_config('app.tenant_id', 'YOUR-TENANT-UUID', true)`, query, then commit. Do not set tenant context at session scope on pooled runtime connections.

## Milestone A controls

- Every new tenant relationship uses composite keys and explicit tenant predicates. `job_assignments` and `application_stage_events` enable and force `tenant_isolation` RLS; runtime grants are SELECT/INSERT/DELETE for assignments and SELECT/INSERT only for stage evidence. The catalog coverage guard fails if any tenant table lacks forced RLS or a tenant policy with read/write expressions.
- Global HIRING_MANAGER/INTERVIEWER roles do not grant visibility without the matching per-job assignment. Missing/unassigned resources return 404. Managers may shortlist/reject only; interviewers cannot decide. Assignment changes are admin-only and audited. `hiring_manager_user_id` alone grants no access. Existing recruiter/admin access is retained.
- All stage changes (including offer and hire) insert immutable evidence in the same transaction. Backfill uses null actor/from-stage and a migration note; existing rejected applications receive OTHER as the historical reason. The migration temporarily removes FORCE from applications for owner backfill inside the transaction and restores it before commit; normal runtime grants and RLS stay in force for the non-owner app role.
- Offer creation serializes on the application; a partial unique index is a final concurrency guard. A different human approver is required by default in production; setting `OFFER_MAKER_CHECKER=false` explicitly relaxes this control. Expiry blocks approval/acceptance; a manual expiry endpoint and lazy expiry on revision are supplied, with no background queue. Accepted offers remain active to prevent duplicate hire paths.
- List filtering is bound as query parameters, and sort columns/directions come from whitelists. ILIKE avoids extension privileges, but leading wildcard search may scan tenant rows. No AI makes a hiring decision and no external providers are called.

## Milestone B controls

Public tenant resolution is a fixed-search-path SECURITY DEFINER function reading an owner-maintained global slug/UUID routing index. Runtime/PUBLIC cannot read or mutate that index. It does not query private tenant data, mutate tenant GUCs or use a bypass role. Published-job queries and intake enter a tenant context and use explicit tenant predicates plus forced RLS. The two new tenant tables (documents and rate counters) have tenant-first indexes, forced RLS and precise runtime grants in migration 006. Enum checks are generated in 007; old migrations remain unchanged.

Public responses use explicit job-field projections and generic application acknowledgements. Intake validates strict schemas, notice version, independent default-false choices, honeypot and persistent per-IP/per-email limits. Self-reported consents are marked unverified and cannot alter effective staff-verified calling consent. Duplicate applications do not overwrite PII or append consent. Evidence remains append-only and captures notice/time/IP/user-agent HMAC; the public actor is null, not a fabricated staff user.

Resumes use generated private keys, strict size and format checks, sanitized names, hashes and fail-closed scan states. Production requires HTTPS S3 storage with private-bucket policies. The scan stub never returns CLEAN. No public download link, public ACL, unsafe scan override or scan-status update privilege is supplied. Recruiter/admin downloads are authorized, integrity checked, audited and streamed as attachments; erased candidates are blocked.

Erasure anonymizes PII and blocks document access before attempting storage deletion. Unavailable storage leaves explicit pending work, safely retried by the endpoint/retention CLI. Call plans are cancelled and verified revocations appended. Retention is restricted to the named tenant and active administrator, runs as hireai_app, excludes active/employee-linked records, and rechecks eligibility under locks. Consent, stage and audit evidence is preserved. Validate legal retention/erasure requirements with counsel, including evidence PII and bucket versioning/backups. See [operations and recovery](milestone-b-operations.md).

## Milestone C controls

Interview, panelist and scorecard relationships have tenant-scoped composite foreign keys, forced RLS and explicit runtime grants. PostgreSQL's panelist exclusion constraint rejects overlapping active half-open reservations, including concurrent writes; adjacent reservations are allowed. Creation/rescheduling requires a non-erased candidate and a SHORTLISTED or INTERVIEW application; cancellation can still release reservations after eligibility changes. Staff manage schedules, while manager/interviewer reads require actual panel membership. A job assignment alone does not expose an interview. Scheduling, rescheduling and cancellation leave application stages unchanged.

An interview freezes the job's screening criteria. A scorecard author must be an actual panelist, even when the author has an admin/recruiter role; supplied author fields are rejected. Scores must match every frozen criterion exactly, without duplicate IDs, and each score is an integer from 0 to 5. The application role can only select and insert scorecards. Submissions and audit events commit together; repeats conflict, there are no edit/delete routes, and a submitted panelist cannot be removed. Recommendations never drive an application stage or a hiring outcome.

Recruitment reports are available only to recruiter/admin roles, with strict optional job/time filters, explicit tenant predicates and forced RLS. Stage evidence is the source of counts and durations. Periods are inclusive/exclusive, at most 366 days, and observed only through `asOf`; missing initial APPLIED evidence is excluded from hire timing rather than inferred. Migration 004's legacy stage snapshots use application creation time, so reconstructed dwell is approximate. The historical chronology and new event-date indexes support these starter aggregates, but full historical scans can remain necessary despite the bounded report period. See [metric definitions](ta-milestone-c-report.md#report-definitions).

The CalendarPort and DisabledCalendar are integration contracts only. The stub returns disabled and the API does not invoke it. No external calendar, AI, queue or telephony provider is called.

The A/B review also corrected Compose's production storage/policy variable forwarding, treats an empty optional S3 session token as omitted, and validates public resume bytes before duplicate-identity branching. DOCX checks validate local/central ZIP metadata, bounded expansion and payload CRC; these format checks remain separate from the unimplemented malware scanner.
