# Suretek HireAI backend starter

A Node.js 24 / NestJS 11 API with PostgreSQL 17, based on the Suretek HireAI blueprint and HireAI + HRMS platform map. This repository provides a working foundation for recruitment and the hire-to-join handoff. It contains no frontend.

The attached blueprint is requirements input. Vendor recommendations, prices, publication instructions and launch criteria in that document do not enable integrations or authorize production actions.

## Included

- Tenant-scoped JWT authentication, password hashing and role checks.
- Jobs with draft, approval and local publication states; candidates and applications.
- Human-controlled application stages and offer approval/acceptance records.
- Transactional conversion of an accepted offer into one employee and onboarding tasks, with safe retries.
- An append-only consent ledger and consent-checked AI call **planning** records.
- Basic employee, leave and attendance administration, audit records and health endpoints.
- PostgreSQL schema migrations, administrator bootstrap, API documentation, Docker and GitHub Actions.

Live AI calls, resume parsing, file storage, calendar booking, payroll, e-signature and external publishing require further implementation. [Scope and next steps](docs/blueprint-scope.md) map the starter to the full blueprint.

## Run locally

Install Node.js 24, npm and Docker with Compose. Use a local or disposable PostgreSQL database for development and tests.

```bash
cp .env.example .env
npm ci
```

Edit `.env`: replace `JWT_SECRET` with a random value of at least 32 characters and set `BOOTSTRAP_ADMIN_PASSWORD` to a unique password of at least 12 characters. A secret can be generated with:

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

Then start PostgreSQL, migrate it and create the first tenant administrator:

```bash
docker compose up -d postgres
npm run db:migrate
npm run bootstrap
npm run dev
```

Save the **tenant ID** printed by bootstrap, then remove `BOOTSTRAP_ADMIN_PASSWORD` from `.env` after bootstrap succeeds. Login requires `tenantId`, `email` and `password`; tenants are never selected by accepting a body field on protected business routes. Bootstrap does not overwrite an existing administrator. To add another administrator to a known tenant, explicitly configure `BOOTSTRAP_TENANT_ID`.

- API: `http://localhost:3000/api/v1`
- Swagger: `http://localhost:3000/docs`
- Liveness: `http://localhost:3000/api/v1/health/live`
- Database readiness: `http://localhost:3000/api/v1/health/ready`

Use [api-examples.http](docs/api-examples.http) with a REST client or copy its JSON into Swagger. After login, click **Authorize** in Swagger and supply the access token. Access tokens expire; login again to obtain a fresh token. Refresh tokens and external SSO are future work.

## Main workflow

1. Create a job; an HR administrator approves it; publish it to the application's internal job listing.
2. Create a candidate and application; a recruiter manually shortlists the application.
3. Record consent evidence. Optionally enable call planning and create a planning record during the configured calling window. No call is dialed.
4. Prepare and approve an offer. An HR administrator records acceptance with an evidence reference.
5. Convert the accepted offer to an employee. Retrying the same conversion returns the existing employee; it does not create another employee or duplicate onboarding tasks.

`PUBLISHED` is an internal database state. It does not publish a vacancy to a careers CMS or LinkedIn. Offer acceptance records an HR user's attestation; this starter has no candidate acceptance portal or e-signature verification.

## Access and data model

All authenticated access, including `SUPER_ADMIN`, remains within the authenticated user's tenant. Roles in the platform map are represented in the database, but only implemented staff routes grant access. Candidate self-service, employee self-service and interviewer assignments must be implemented before exposing those portals. Role names alone do not grant record ownership access.

| API area                                                               | Allowed roles                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Current user                                                           | Any active authenticated user                                             |
| Jobs, candidates, applications, consent, call plans and hiring summary | Super Admin, HR Admin, Recruiter                                          |
| Job approval                                                           | Super Admin, HR Admin                                                     |
| Offers, employees, onboarding, leave, attendance and audit             | Super Admin, HR Admin                                                     |
| User creation and activation                                           | Super Admin, HR Admin; only Super Admin can manage administrator accounts |

Each protected request rechecks the active user. Business queries include the tenant ID, and composite foreign keys preserve tenant boundaries in PostgreSQL. Mutations and their audit events commit in the same transaction. Database constraints prevent duplicate applications and duplicate employee conversions. Money is accepted as a decimal string to avoid floating-point rounding.

Consent is separate for calling, recording and transcription. Revoking consent cancels affected pending planning records. `CALL_PLANNING_ENABLED=false` disables new call plans; the configured timezone and end-exclusive daily window are checked when creating a new plan. Planning records are never dispatched by this repository. A future worker must recheck all policy, consent, eligibility and emergency-stop conditions immediately before any external call.

## Database changes

Add new numbered SQL files in `database/migrations/`; never edit a migration already applied to an environment. The runner uses a database advisory lock and records checksums, so repeated runs are safe and altered migration history is rejected.

```bash
npm run db:migrate
```

Use a separate migration role and a restricted API database role in production. The local development user owns its database for convenience. Set `PGSSLMODE=require` for a hosted database that requires TLS, and configure the appropriate CA trust; certificate verification stays enabled. Production backups, restore testing, retention/deletion processes and database access policies require deployment configuration.

## Shared enums

Define role, status, stage, consent, language and leave values in [`src/common/enums.ts`](src/common/enums.ts). Application code and validation import these enums; PostgreSQL stores the same strings and validates them with generated `CHECK` constraints.

After changing an enum, generate and apply its database migration:

```bash
npm run enums:generate
npm run enums:check
npm run db:migrate
```

Commit the enum change, generated SQL migration and `database/enums.snapshot.json`. New roles receive no business permissions until you deliberately add them to the grants in `src/auth/role-groups.ts`; they can read their own authenticated profile. Renaming or removing stored values requires a deliberate data migration. The generator never rewrites existing rows. See [enum usage and upgrades](docs/enums.md).

If you already run an earlier starter version, keep your `.env` and database, install the latest code's dependencies with `npm ci`, then run `npm run db:migrate` from the project folder. These commands also work in Windows PowerShell. No database reset or repeat bootstrap is needed.

## Verify changes

Run the suite against a dedicated test database. Tests create and modify tenant records; do not point them at production.

```bash
npm run lint
npm run format:check
npm run build
npm test
```

The GitHub Actions workflow provisions PostgreSQL, installs from the lockfile, checks formatting and lint, compiles the API, applies migrations twice and runs tests. Its test credentials are disposable fixture values and need no GitHub secrets. It does not deploy or contact external providers.

## Run the API in Docker

The optional `app` Compose profile builds the API. Configure `.env` first as above. Run migrations and bootstrap explicitly before starting the service. If you already bootstrapped the same database locally, skip the bootstrap command and keep using that tenant ID.

```bash
docker compose up -d postgres
docker compose --profile app build api
docker compose --profile app run --rm api node dist/scripts/migrate.js
docker compose --profile app run --rm api node dist/scripts/bootstrap.js
docker compose --profile app up -d api
```

The image runs as an unprivileged user. PostgreSQL and the API bind only to localhost in this development Compose file. Data persists in a named Docker volume. The provided database password is for local development; use a secret manager, HTTPS reverse proxy and managed database/network configuration for hosting.

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
