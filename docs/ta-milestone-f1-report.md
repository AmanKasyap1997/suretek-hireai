# F1 implementation report

Branch: feature/ta-milestone-f1-login-and-role-shell. Based on merged Milestone E. The plan's Auth and roles discovery was written before UI code; browser adapter changes are a separate first commit.

## Roles, API gaps and decisions

The full backend-derived ten-role permission table is in talent-acquisition-plan.md. SUPER_ADMIN and HR_ADMIN see recruitment, offers, people and administration placeholders; only super admin can administer other administrator accounts. RECRUITER sees jobs/applications/candidates/interviews/reports. HIRING_MANAGER and INTERVIEWER see assigned jobs/applications and interviews; manager stage changes and panel scorecard permissions remain enforced by the backend. CANDIDATE, EMPLOYEE, REPORTING_MANAGER, PAYROLL_FINANCE and IT_ASSET_ADMIN only have own-profile access and an empty-workspace placeholder. No new business permissions are granted.

Existing bearer login/me remain intact. New POST/GET/DELETE auth/session adapt the existing JWT into an HttpOnly Strict cookie, with Secure in production and exact Origin checks on unsafe cookie requests, login and logout. Session GET exposes user and expiration, never a JWT. No persistent session table/migration or auth redesign. Logout clears browser credentials; copied JWT revocation is still absent. Refresh, password reset, forced first-login change, lockout and login CAPTCHA are absent and explicitly documented; UI does not invent them. Invalid/disabled accounts are indistinguishable. 423 support is future-facing only. Tenant is build-time public configuration, not user-selected. Routes preserve intended paths in router state and allowlist them after login; query strings are excluded.

Brand assets/website URL were not supplied: provisional wordmark, deep teal/mint palette and system fonts are clearly marked in tokens.css and UI. Approved branding remains a manual step. Dependency justification is in web/README.md: requested React/Router/Query/form/zod stack, plus development lint/build/test tools. No telemetry or component framework.

## Screen descriptions

- All roles share a split welcome/login page with labeled email/password, visibility control, accessible validation, pending state, generic credentials errors and distinct throttle/network/expired notices. At 360px, panels stack vertically.
- Each role has its own named overview with account name/role/sign-out menu, shared sidebar and coming-soon cards for only its allowed coarse permissions. Profile-only roles show an active-account/empty-workspace card.
- Forbidden direct routes show Not permitted, unknown routes show Page not found, startup has loading/retry, and runtime errors have a reload boundary. Expiry removes protected content and shows a login notice; logout clears query cache. No jobs, applications or candidates screen is implemented.

## Validation

Validation results are recorded after the full local and CI runs. Web unit tests cover every role home/guard, navigation, validation, cache clearing, 401 and expiry. Playwright exercises every role against real Compose API/PostgreSQL, reload, forbidden navigation, logout/back and actual 60-second expiry. CI also builds both production images, checks Compose and shellcheck and preserves backend checks.

## Manual server steps

1. Supply approved logo/font/colour assets and replace labeled tokens.
2. Set Actions PILOT_TENANT_ID to the actual pilot UUID. Publish a version tag to ship API and web/Caddy together.
3. Add the exact same-origin console HTTPS origin to CORS_ORIGINS; keep HTTPS, proxy count and existing hardening.
4. Deploy via existing backup/migrate/health workflow. Open /console/login and test each provisioned role, forbidden routes, logout/back, expiry and reload.
5. Verify CSP, no-store HTML, immutable hashed assets, HttpOnly/Secure/Strict cookie, Origin rejection and no sensitive logs. Test keyboard focus/errors and 360px layout with approved assets.
6. Password help remains an administrator operation. Never seed test accounts in production.

## PR description

Add a same-origin /console login and shared role shell for all ten backend roles. Preserve existing bearer auth and add a separately committed HttpOnly cookie session adapter with exact-Origin CSRF checks. Provide role-filtered disabled navigation/cards, session startup/expiry/logout and error states, responsive placeholder branding, guarded test-user seeding and tagged static assets in the hardened Caddy companion. No business screens, refresh/reset redesign, AI, queue or call dispatch. See web/README.md for dependency rationale and operational boundaries.
