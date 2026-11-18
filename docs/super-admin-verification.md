# Super Admin completion review

This records the earlier completion review. For the subsequent organization-owned integrations and 404 investigation on the same branch, see [the current review](super-admin-review.md).

Reviewed latest main `8df6ac8` on 2026-11-17. Work branch: `feature/super-admin-completion`. The existing implementation already supplied the module; this review preserves it and closes the gaps recorded in [the audit](super-admin-audit.md).

## Changes

- `src/modules/super-admin`: failed sandbox verification revokes matching production approval with serialized state changes; organization audit filters include integration overrides; dashboard warnings account for call minutes and avoid empty zero-quota/expired active-trial warnings.
- `src/modules/saas`: no resend for suspended/deleted organizations; legacy lists exclude soft-deleted organizations.
- `src/modules/auth` and migration `016_unresolved_login_audit.sql`: generic 401 for nonexistent organizations, anonymous append-only failed-login evidence, suspended-login evidence and password-policy enforcement for direct staff creation.
- `web/src/SuperAdminPages.tsx`, shared shell/CSS: inline validation, dismissible result notifications, full-length OAuth credentials, local-time trial-date round trips, ascending name sort, organization audit/CSV filters, persistent edit results, delete navigation and mobile drawer dismissal.
- Backend/API/frontend/browser regression tests; formatting corrections in the pushed Super Admin code; README, scope, security, API examples and operations documentation.

No new dependencies or environment variables. Existing production Compose already forwards integration settings. The legacy test-only MinIO image remains confined to development/CI; production storage configuration is unchanged.

## Decisions and boundaries

Existing `tenant_id` remains the organization identifier, preserving data and forced RLS. The platform's directory and explicit aggregate queries expose usage, governance and administrator contacts, never candidate/employee records. SMTP follows committed provisioning because it cannot participate in a PostgreSQL transaction. Unknown-organization failures contain no submitted identifiers; before platform bootstrap there is no platform audit destination. CSV exports the selected filtered page and says so in the UI. Limits are monitored governance settings, not billing or automatic deletion rules.

Optional TOTP/recovery and time-limited support access remain explicitly deferred as documented in [operations](super-admin.md). Support bypass is absent. Provider-specific OAuth acquisition/refresh and non-bearer transports require provider contracts; the connection registry fails explicitly when verification is unconfigured. No AI screening, call dispatch, queue or tenant HR workspaces were introduced.

## Validation

Local validation uses Node 24, PostgreSQL 17 in Docker, a non-owner `hireai_app` runtime, and separate owner/admin test connections.

| Command/check                                                      | Result                                                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` (root and web, workspace npm caches)                      | Passed                                                                                                                                      |
| `npm run enums:check`                                              | Passed                                                                                                                                      |
| Root lint, format check, TypeScript production build               | Passed                                                                                                                                      |
| `npm run db:migrate` twice                                         | Passed on upgraded database and fresh scratch database, migrations 001–016                                                                  |
| `npm test` as `hireai_app`                                         | 218 passed, 35 suites, route snapshot passed; includes real MinIO round trip, fake TLS SMTP, forced-RLS coverage and cross-tenant API tests |
| Web lint, format check, `typecheck`, `npm test`, production build  | Passed; 52 tests                                                                                                                            |
| Production Compose config with explicit `--env-file deploy/ci.env` | Passed                                                                                                                                      |
| Shellcheck on repository shell scripts                             | Passed                                                                                                                                      |
| Browser tests                                                      | Full run in progress; real TLS invitation onboarding passed. Final result recorded below after completion.                                  |
| Production API/edge Docker builds                                  | GitHub CI requested; local workspace disk capacity is insufficient for simultaneous full image builds. Final CI result recorded below.      |

Initial checks caught an existing computed-property lint error, unformatted files, case-sensitive heading expectations and a browser assertion that ignored enabled modules. These were corrected. Test fixtures and generated credentials are disposable and excluded from git.

## Real-server checklist

1. Back up PostgreSQL, resume storage and the stable integration encryption key. Migration rollback requires restoring a backup; do not edit applied migrations.
2. Pull the reviewed version and run the owner migration command (`npm run db:migrate`, or the production Compose migrate service) **before** restarting the new API. Ensure migration 016 is present.
3. For the first platform owner, set `SUPER_ADMIN_EMAIL`, a strong `SUPER_ADMIN_INITIAL_PASSWORD` and stable `BOOTSTRAP_TENANT_ID`; run `npm run bootstrap:platform`. In a production image run `node dist/scripts/bootstrap-platform.js` with the owner connection and these operator variables. Existing accounts retain their password on retry. Remove the initial password from the environment afterwards.
4. Visit `/console/login`, organization `platform`, and change the initial password when prompted. Existing installation credentials are not reset by this review.
5. Configure real SMTP and `PUBLIC_WEB_BASE_URL`; create a trial organization, receive/accept its HR Admin invitation, and check that HR Admin cannot open platform pages.
6. Configure and securely back up `INTEGRATION_ENCRYPTION_KEY` (64 random hex characters). Configure trusted HTTPS verification endpoints for custom providers. Verify sandbox and production separately before enabling production; test a failed sandbox check revokes approval.
7. Verify suspension blocks existing sessions and new logins, reactivation retains data, module toggles affect menus/API access, and typed soft deletion prevents resend.
8. Review retention/calling/session/password defaults, administrator membership, audit/CSV filters and aggregate reports. Validate backups/restore, HTTPS, certificate renewal and operational monitoring using `deploy/README.md`.

Live provider credentials, real SMTP deliverability, production DNS/TLS and real-server hardening were not available here. The production backup/restore drill was not repeated for this Super Admin review; it changes no backup scripts or storage format. Validate those on the target server before rollout.

## PR description

Complete the review of the pushed Super Admin module: revoke stale production approvals when sandbox verification fails, prevent invitation resend for unavailable organizations, record anonymous unresolved-login failures, enforce password policy consistently and correct governance warnings/audit filtering. Improve console validation, notifications, long-token entry, dates and navigation while retaining the existing stack, tenant isolation and branding.

Includes forward-only migration 016 and backend/API/frontend/browser regression coverage. Optional MFA/support access and provider-specific OAuth flows remain documented, not silently simulated. See the validation table and server checklist above.
