# Suretek console (F1)

Unified sign-in and role shell only, at `/console`. All ten backend roles are supported without a role picker. No jobs, application or candidate screens are implemented. The authoritative role/permission discovery table is in `docs/talent-acquisition-plan.md`.

## Development

Use Node 24. Run `npm ci` in root and web. Configure a dev/test database and backend as in the root README; set `CORS_ORIGINS=http://localhost:5173`. Set `VITE_TENANT_ID` to the pilot tenant UUID before `npm run dev` in web. Vite proxies `/api` to localhost:3000 (API_TARGET may override). The tenant UUID is public build configuration, never a secret or authorization mechanism. Authentication verifies membership in the backend.

For controlled fixtures, set NODE_ENV=test (or development), DATABASE_MIGRATION_URL to a database whose name ends in _test or _dev, SEED_TENANT_ID and SEED_PASSWORD (12–128 characters); run `npx tsx scripts/seed-console.ts` from root. This inserts one `ROLE@console.test` account per role (lowercase), and resets only their test passwords on retry. Never target real data. The script refuses production and missing passwords.

## Session/security

POST /api/v1/auth/session accepts the existing login body and issues an HttpOnly, SameSite=Strict cookie; Secure is enabled in production. GET returns `{user:{id,tenant_id,full_name,email,role,active},expiresAt}`; DELETE clears the cookie. Every unsafe cookie-authenticated API request, browser login and logout requires an exact CORS_ORIGINS Origin. Login returns no token to JavaScript. Nothing is stored in localStorage/sessionStorage. Startup loads the session, expiry and any API 401 clear the React Query cache and redirect to login. Intended routes are held in router state, with query/fragment removed and role allowlisting on return. No silent refresh is available; log in again at expiry. Logout cannot revoke a copied stateless JWT, which remains valid until expiry; browser cookie removal and cache clearing are immediate. A network failure during logout shows a retry warning; do not leave a shared browser until server sign-out succeeds.

No reset, first-login change, account lockout or login CAPTCHA exists in this backend. Disabled and invalid users have the same 401. UI handles 423 if a future server supplies it and 429/network errors distinctly. Password help directs users to their administrator. No fabricated reset route or CAPTCHA widget is shown.

Open tabs synchronize sign-out and account changes using BroadcastChannel event names only; no tokens or personal data are sent between tabs. Focus, pageshow and returning to a visible tab revalidate the HttpOnly-cookie session with the backend, including when BroadcastChannel is unavailable. A changed user, tenant or role clears cached data before the new session is shown. Failed revalidation hides the previous user until retry succeeds. A local or broadcast sign-out suppresses automatic revalidation so a failed server logout cannot silently restore the old account; explicit sign-in or a sign-in notification from another tab resumes it.

## Branding and UI

Approved website assets were not provided. `src/tokens.css` explicitly marks the provisional deep teal/mint colours, system-font stack, spacing and type tokens. The text Suretek wordmark is labeled a brand preview. Replace these with approved assets before launch. Login is a split welcome/form screen that stacks at 360px. The shared shell has a sidebar, account menu, role-specific overview, disabled coming-soon items and cards. Profile-only roles have an empty-workspace card. Forbidden, missing page, session-expired notice, startup loading/retry and error-boundary states use the same typography. User content is React-escaped; no HTML injection or client logging/error telemetry is used.

## Build/release and server

Set repository Actions variable PILOT_TENANT_ID to the actual tenant UUID before publishing a v*._._ tag. It becomes the VITE_TENANT_ID build argument in the tagged Caddy companion image. The multi-stage image installs/builds web then copies only dist into `/srv/console`; API and edge use the same release tag. No new host ports. Caddy preserves automatic HTTPS, docs blocking and hardening. `/console/*` uses SPA fallback, self-only scripts/styles/connect CSP with no inline scripts, immutable hashed assets and no-store HTML. Login does not use CAPTCHA, so no third-party CSP allowlist is needed. Add the console HTTPS origin to CORS_ORIGINS, deploy both images, verify Secure/HttpOnly cookies, POST Origin rejection, expiry/logout, CSP and cache headers. Existing deploy/smoke.sh also loads the console login document; full applicant smoke still requires its existing inputs. Clear old cached HTML on upgrade if an earlier proxy cached it.

## Tests

`npm run lint`, `format:check`, `typecheck`, `test`, `build`. For real-backend E2E set the credentials required by `deploy/compose.e2e.yaml`, the same SEED_TENANT_ID/VITE_TENANT_ID and SEED_PASSWORD. Run `docker compose -f deploy/compose.e2e.yaml up -d --build --wait api`, `npx playwright install chromium`, then `npm run e2e` in web. This uses a disposable PostgreSQL backend and real login throttling (tests wait between groups). Stop with `docker compose -f deploy/compose.e2e.yaml down -v`. Never use production credentials. Screenshots/traces/video are disabled to avoid credential/PII artifacts.

Dependencies: React/ReactDOM render the shared UI; React Router manages guarded routes/history; TanStack Query owns cached API data and logout clearing; react-hook-form manages accessible form state; zod and @hookform/resolvers validate form/server shapes. Vite/TypeScript compile assets; Vitest/jsdom/Testing Library test browser state; Playwright tests real-backend journeys; ESLint/Prettier enforce consistency. No UI component or telemetry library was added.
