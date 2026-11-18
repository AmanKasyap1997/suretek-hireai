# Branch review and organization integration completion

Reviewed `feature/super-admin-completion` against the supplied Super Admin requirements and the additional platform-enable / organization-connect workflow. The audit precedes the changes in `super-admin-audit.md`. The supplied document is requirements context; deployment and real-provider authorization remain operator actions.

## Requirement coverage

| Area                                | Implementation / review result                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six-section Super Admin menu        | Existing central role navigation, guards, desktop collapse/mobile drawer; covered by unit/browser tests.                                                                                                                               |
| Tenant model, roles, invitations    | Existing tenants and `tenant_id` preserve IDs/RLS; generated user status, multiple role memberships, hashed expiring invitations and first-login password rotation. No duplicate organization model or data migration to a new tenant. |
| Dashboard, organizations, lifecycle | Real usage/status queries, filters/pagination, transactional creation, invitations, profile/modules/limits, suspension and typed soft deletion already implemented and tested.                                                         |
| Provider availability               | Added global non-secret catalog. Only an actual platform Super Admin can change it; organization admins see enabled providers only.                                                                                                    |
| Organization connections            | Added session-scoped API/UI, encrypted tenant-owned credentials, appropriate provider methods, OAuth PKCE/refresh, tests/production gate, disconnect and audit. Existing platform connections remain compatible.                       |
| Settings and Super Admin management | Existing defaults, calling emergency pause, password/session policy and locked last-admin protection; retained and regression tested.                                                                                                  |
| Audit and reports                   | Append-only logs/filter/export retained. New provider/connection actions audited in their owning scope; platform reports include organization integration error totals and health counts without credentials or business PII.          |
| Security                            | Central server role checks, forced RLS, strict input validation, origin checks, throttles, write-only encrypted secrets, hashed user-bound OAuth state, fixed/operator-owned endpoints and verified TLS.                               |
| Optional features                   | TOTP/recovery and support access remain explicitly deferred as allowed by the requirements. No impersonation bypass.                                                                                                                   |

Supported provider methods and the exact operator setup are documented in `super-admin.md`. There is no universal authentication protocol: custom vendor service accounts, proprietary exchanges or application-only calendar APIs need explicit provider adapters. The implementation does not pretend that a saved secret means a verified connection, or that a verified connection implements future calling/AI/business workflows.

## Changed file groups

- `database/migrations/017_organization_integrations.sql`: provider availability/revisions, connection method/version fields and tenant-isolated encrypted OAuth state. Migration 018 indexes tenant-scoped OAuth cleanup and provider ownership lookups. No previously shipped migration is edited.
- `src/modules/organization-integrations/*`: provider catalog, schemas, authenticated controllers, encrypted connection lifecycle, OAuth consent/exchange and provider-specific verification.
- `src/modules/saas/saas.module.ts`, `src/modules/super-admin/super-admin.service.ts`: route registration and aggregate health/usage.
- `web/src/OrganizationIntegrations.tsx`, `App.tsx`, `SuperAdminPages.tsx`, `permissions.ts`, `styles.css`: provider controls, organization connection screens, OAuth callback and shared navigation/theme.
- Backend/API/RLS/route-contract tests, frontend tests and `web/e2e/z-integrations.spec.ts`: isolation, availability, production gate, secret protection, OAuth, SMTP and actual backend browser flow.
- `.env.example`, development/production/test Compose: integration configuration forwarding; test-only encryption key in isolated E2E Compose.
- `scripts/check-api-routes.ts`, `package.json`, README and operations docs: reproducible 404 diagnostics and setup.

## 404 finding

Both reported routes were already registered in the branch. Tested against the running Nest application and the Vite proxy: unauthenticated requests return 401; authenticated platform requests return 200. No reproduction of a source-level 404. `npm run api:check` checks those paths plus the new routes and fails explicitly on 404/unreachable targets. The likely deployment causes are an old API build/image/process, a different `API_TARGET`, or an incorrect proxy path. Pull, migrate, build and restart the backend as described in `super-admin.md`; a frontend-only rebuild cannot fix a stale backend.

## Rollout

1. Back up the database and stable encryption key. Apply migrations 017–018 with the owner connection (`npm run db:migrate`); application credentials remain non-owner/non-BYPASSRLS.
2. Build/restart the API and frontend together. Verify direct and proxied routes with `npm run api:check` and `API_CHECK_ORIGIN`.
3. Sign in as Super Admin with organization `platform` and the previously bootstrapped credentials. New accounts must change the initial password; bootstrap retry does not reset existing passwords.
4. Configure `INTEGRATION_ENCRYPTION_KEY`, enable a provider, then use an Organization Admin session to connect its own account. Configure trusted custom endpoints/SMTP and register OAuth callback URLs as applicable.
5. Verify sandbox and production separately. Confirm disabling the provider hides it and blocks connection operations. Existing records are retained; re-enable requires verification again.

Real provider consent, credentials, SMTP authentication and vendor permissions must be exercised using your organization's accounts. Automated tests use isolated fixtures and mocked provider responses; no real customer messages, calendar changes, calls or AI requests were sent.

## Validation performed locally

- Fresh PostgreSQL migration through 017 and a second no-op migration run: passed. The subsequent index-only migration 018 was applied and retried successfully.
- Backend lint/build/format and enum checks: passed. Full non-MinIO suite: **228 tests passed**, including real PostgreSQL API/RLS tests under the restricted runtime role. The one unchanged real-MinIO test is left to the PR's MinIO-enabled CI job.
- Frontend lint/type-check/production build and **56 unit tests**: passed.
- Existing Super Admin six-screen mocked browser test and the new **actual-backend** provider enable / organization connection / disable / disconnect browser test: passed. The latter also checks mobile overflow at 360px. Complete invitation/session browser regression remains included in PR CI.
- Direct API and Vite proxy route smoke checks: all four protected routes return 401 as expected; authorized organization/integration endpoints also return 200 in API tests.
- Production Compose validation: passed. Full production-image builds and repository-wide browser/MinIO results are reported by the PR checks; local tests do not claim real vendor verification.
