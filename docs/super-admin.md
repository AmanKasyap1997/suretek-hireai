# Super Admin operations

## Upgrade and first sign-in

Apply the forward-only migrations with `npm run db:migrate` using the owner connection (`DATABASE_MIGRATION_URL`). Migration 013 extends existing `tenants`/`platform_organizations`, users, invitations and audit evidence; 014 maintains a metadata-only directory for legacy organization registration; 015 grants the narrowly scoped invitation-provenance update; 016 records anonymous unresolved-organization login failures. Existing organization IDs, data and forced RLS are preserved. No second ORM or replacement auth system is introduced. The existing `tenant_id` is the organization identifier. Platform users remain in their dedicated platform tenant to preserve existing RLS invariants.

Set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_INITIAL_PASSWORD` (12–128 characters), and a stable `BOOTSTRAP_TENANT_ID`, then run `npm run bootstrap:platform`. `BOOTSTRAP_TENANT_NAME`, `BOOTSTRAP_ADMIN_NAME` and the older bootstrap email/password variables remain supported. New accounts must change their initial password before accessing any business or platform API. A retry preserves the existing password. Bootstrap also imports metadata for legacy organizations, without candidate/employee data. Remove the initial password from the environment afterwards. There are no shipped credentials or production demo seeds.

Sign in at `/console/login` with organization **platform** and the supplied email/password. The landing page is `/console/super-admin/dashboard`. Non-platform users cannot use `/api/v1/super-admin/*`; every endpoint has a central role guard plus a database-backed platform-membership check. Platform users are excluded from tenant recruitment and HR APIs even if additional role memberships were manually assigned.

## Organizations

Use Organizations → Add organization. Enter profile, unique sign-in slug/domain, location/timezone, plan, trial/active state, modules, limits and first HR administrator. Provisioning, initial inactive user, hashed invitation, governance metadata and audit events commit together. SMTP delivery occurs **after commit**, since email is not transactional. A failed delivery is visible and can be resent. Invitations default to seven days (`INVITATION_TTL_SECONDS=604800`); explicit existing settings take precedence. Tokens are hashed, single-use, expiring and replaced on resend; never logged or returned from provisioning APIs. Configure the existing SMTP adapter for actual delivery; development log/disabled adapters deliberately report undelivered rather than exposing invitation secrets in logs.

Details provide profile/module/limit editing, aggregate usage, HR-admin contacts, initial-invitation resend and platform audit events for that organization. Resending requires an organization that is neither suspended nor deleted. Suspension requires a reason and blocks existing sessions, new sign-ins, invitation acceptance and public hiring APIs. Reactivation retains data. Soft deletion requires the exact organization name and retains all records. A deleted slug/domain remains reserved. Legacy imported organizations without an initial invitation cannot use the initial-invite resend action.

The primary user role remains compatible with existing clients. `user_roles` stores additional memberships; the guard picks an allowed membership for each tenant operation. `PATCH /saas/users/:id/roles` accepts `{roles:[...]}` for HR admins managing their own staff. It cannot assign HR_ADMIN or SUPER_ADMIN, alter another organization, or modify administrator accounts. Platform account creation/disable actions live under Settings; row locking prevents concurrent removal of the last active Super Admin.

## Integrations and secrets

Set `INTEGRATION_ENCRYPTION_KEY` to 32 random bytes encoded as 64 hex characters, generated with a cryptographic RNG. AES-256-GCM uses a fresh nonce and authenticates tenant/provider/environment/scope. Keep this key stable, secret and backed up; replacing it without re-encrypting stored credentials makes them unreadable. No raw or encrypted credential is returned by list/test/enable APIs; the UI receives only the last four characters.

OpenAI, Google Calendar and Microsoft Calendar tests use fixed read-only HTTPS endpoints with bearer credentials. Calendar credentials are OAuth access tokens; acquiring/refreshing them is outside this connection registry. Other providers use explicitly operator-configured `INTEGRATION_TELEPHONY_VERIFY_URL`, `INTEGRATION_EMAIL_VERIFY_URL`, `INTEGRATION_CAREERS_CMS_VERIFY_URL`, `INTEGRATION_E_SIGNATURE_VERIFY_URL`, or `INTEGRATION_HRIS_VERIFY_URL`. These must be trusted HTTPS endpoints accepting the provider's bearer token and returning success only after verification. Arbitrary browser-supplied URLs and redirects are prohibited; requests have a timeout. Missing endpoints fail explicitly, never simulate a successful connection.

Each environment is tested independently. Production enable requires successful current production and matching sandbox verification. Rotating credentials invalidates verification; rotating sandbox or failing a sandbox re-test also invalidates production enablement. Verification completion, rotation and enable use the same lock order so concurrent actions cannot retain stale approval. Optional organization overrides have their own sandbox prerequisite. This module manages connection configuration and verification; it does not introduce telephony execution, OAuth consent/refresh flows, or replace the existing SMTP transport configuration.

## Governance, reports and audit

Settings stores retention defaults, calling hours, monthly planned-call quota, emergency pause, minimum password length and session lifetime. Saved retention defaults feed the existing retention worker; calls remain subject to the existing environment enable switch and calling window as well as the platform controls. Session policy bounds new JWT lifetimes. Password policy applies to invitations, direct staff creation and password changes; initial admin passwords always require at least 12 characters. Organization limits are configured and shown against measured usage; they are not billing enforcement or automatic data deletion.

Audit is append-only for the runtime database role and has no update/delete API. Platform logs include sign-in/sign-out/failures, organization actions, role administration, invitations, integrations and settings. Filters support action, organization, dates and pagination. Organization filtering includes integration override events as well as organization lifecycle events. The global console accepts the organization UUID shown in its detail URL; CSV uses the same filters. CSV exports the selected page, explicitly labeled in the UI; dangerous spreadsheet prefixes are escaped. IP and bounded user-agent evidence are stored in the database, never ordinary request logs. Tenant candidate/employee audit payloads are not exposed in the platform viewer.

Usage reports contain organization totals, users, document storage, current-month measured call minutes and integration error counts. The existing calling subsystem only plans calls: records without provider duration are shown separately as **unmetered calls**, not invented minutes. Storage currently covers retained candidate documents; no other binary storage domain exists in the repo. Reports exclude candidate/employee records.

## Adding modules and navigation

Add the stable module ID to `super-admin.schemas.ts` and the organization module selector. Map its API routes in the central `AuthGuard`, and its menu ID in `web/src/permissions.ts` (`permissionMap`, `moduleForMenu`, `navigation`). Add the role decorators and tenant predicates/RLS to its service. Super Admin navigation remains the separate central six-item `platformNavigation`; do not add page-specific menus. Phase 2/3 toggles manage rollout availability; those day-to-day HR workspaces remain existing/future modules, not implemented by this platform-owner task. Hidden modules are also rejected by route guards for implemented routes.

## Explicit deferred work

- Optional TOTP and recovery enrollment: the current custom auth system has no recovery-factor or enrollment workflow. Strongly recommended before external production platform administration; implement audited enrollment, replay prevention and recovery together rather than accepting an unverified OTP field. No claim of MFA protection is made.
- Optional support access: intentionally disabled. There is no impersonation or bypass route. A future implementation must be read-only, reason-logged, expiring and tenant-approved where appropriate.
- Proprietary provider authentication, service-account delegation and measured telephony delivery callbacks require provider-specific contracts/adapters. Google/Microsoft delegated OAuth and standard methods are implemented below; unconfigured verification fails explicitly.

See `super-admin-audit.md` for the pre-implementation audit and `super-admin-verification.md` for test results and environment limits.

## Organization-owned integrations (migration 017)

Super Admin → Integrations → **Available to organizations** controls the non-secret provider catalog. Every provider starts disabled; enabling one does not share platform credentials or connect any organization. Organization Admin → **Integrations** then shows only enabled providers. The admin chooses sandbox/production and a supported method, supplies their organization's credentials, tests, and enables the connection. Production requires successful current sandbox and production verification. Disconnect removes the encrypted credentials and invalidates dependent production approval. Disabling a provider blocks save, OAuth, test and enable APIs immediately; re-enabling requires fresh verification. Organization IDs are derived exclusively from the authenticated session, never submitted by the browser. Super Admin cannot read those credentials, including ciphertext. Aggregate error counts and health are included in platform reports/dashboard.

| Provider                            | Supported connection methods                                              |
| ----------------------------------- | ------------------------------------------------------------------------- |
| OpenAI, Anthropic                   | API key, with each vendor's required headers                              |
| Google Calendar, Microsoft Calendar | OAuth consent with PKCE, existing OAuth refresh token, or an access token |
| Telephony, careers CMS/API, HRIS    | API key, bearer token, username/password, OAuth client credentials        |
| E-signature                         | API key, bearer token, OAuth client credentials                           |
| Email                               | SMTP over verified TLS, API key, bearer token                             |

Methods are provider-specific; the API rejects incompatible methods and unknown credential fields. Tokens/secrets are write-only and encrypted together using the existing AES-GCM key, bound to organization/provider/environment. OAuth state is hashed, bound to the initiating user and tenant, expires after ten minutes and is consumed once. PKCE verifier and client secrets are encrypted. Refresh-token rotation is retained during verification. A plain access token must be replaced when it expires; use OAuth consent/refresh for renewable authorization. Verification reads metadata (or performs SMTP AUTH); it does not send mail, place calls, sign documents or execute AI requests. This registry does not add future business workflows automatically.

For OAuth, each organization registers its own Google/Microsoft application with callback `https://YOUR_DOMAIN/console/integrations/oauth`, then enters its client ID/secret and grants consent. Set `PUBLIC_WEB_BASE_URL` to that same origin. The callback page removes the authorization query from the address bar and completes the exchange through the authenticated, origin-checked API. A declined, expired or reused authorization must be restarted. Google/Microsoft delegated calendar scopes are requested; enterprise admin consent may be required by the provider. Provider-specific service accounts, application-only calendar permissions and proprietary authentication require separate adapters; unsupported methods are never shown as working connections.

Custom provider verification uses the existing operator-owned `INTEGRATION_<PROVIDER>_VERIFY_URL` (HTTPS, no redirects). OAuth client credentials additionally require `INTEGRATION_<PROVIDER>_TOKEN_URL`; token endpoints accept standard form-encoded client credentials. API keys default to `X-API-Key`; configure `INTEGRATION_<PROVIDER>_API_KEY_HEADER` if needed. Custom verification endpoints must genuinely authenticate the account and return success only for valid credentials. SMTP requires `INTEGRATION_EMAIL_SMTP_HOST` and optional `INTEGRATION_EMAIL_SMTP_PORT` (465 default, or 587 STARTTLS). Endpoint/SMTP host configuration is platform-operated to prevent browser-supplied addresses reaching internal services. Organizations supply their own account credentials, but cannot select arbitrary network destinations. All variables are forwarded in development and production Compose. Do not reuse invitation SMTP credentials automatically.

New APIs:

- `GET /api/v1/super-admin/integration-providers`, `PATCH .../:provider` with `{ "enabled": true }` (Super Admin).
- `GET /api/v1/organization/integrations/providers` and `GET /api/v1/organization/integrations` (Organization Admin).
- `POST /api/v1/organization/integrations` with provider, environment, method and credentials; no organization ID.
- `POST .../:id/test`, `POST .../:id/enable`, `DELETE .../:id` (disconnect, retaining audit evidence).
- `POST .../oauth/start` and `POST .../oauth/complete` for the user-bound consent flow.

The existing `/super-admin/integrations` API remains compatible for platform-owned connections/legacy overrides. Those records are not copied to organizations and are not returned by organization connection APIs. Organization integration changes are append-only audited in their own tenant scope; availability changes are audited in the platform scope.

## Diagnosing `/api/v1/super-admin/*` 404s

Both reported GET routes (`organizations`, `integrations`) are registered in `SaasModule`, imported by `AppModule`. An unauthenticated request must return **401**, not 404. A signed-in organization admin gets **403**. A fresh Super Admin must first change their initial password.

From the repository root, after pulling this branch:

```sh
npm ci
npm run db:migrate
npm run build
npm start
```

In another terminal run `npm run api:check`. It tests the running API on `http://localhost:3000` without credentials. To check the frontend proxy or deployment, set `API_CHECK_ORIGIN=http://localhost:5173` or your HTTPS site origin and run it again. The check prints only route names/status codes. A passing direct API check with a failing proxy check identifies proxy routing; a direct 404 indicates an old/different API process or image. Stop the old process and restart the newly built API. Set `API_TARGET` when starting Vite if the API is not on port 3000. `vite preview` is not the supported development proxy; use `npm --prefix web run dev`. Do not prepend `/console` to API URLs.

For Compose deployments, rebuild/pull **both API and web images**, apply migration 017, and recreate the API service using the existing deployment runbook. Rebuilding only the frontend cannot update backend routes. Migration 017 preserves all existing platform connections and tenant IDs; migration 018 indexes tenant-scoped OAuth cleanup and provider ownership. Apply both with the migration command; back up the database and encryption key before deployment.
