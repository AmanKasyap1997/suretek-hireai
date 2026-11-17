# Suretek console (F1)

Unified sign-in and role shell only, at `/console`. All ten backend roles are supported without a role picker. No jobs, application or candidate screens are implemented. The authoritative role/permission discovery table is in `docs/talent-acquisition-plan.md`.

## Development

Use Node 24. Run `npm ci` in root and web. Configure a dev/test database and backend as in the root README; set `CORS_ORIGINS=http://localhost:5173`. Copy `web/.env.example` to `web/.env.local` and set `VITE_TENANT_ID` to the existing tenant UUID printed by bootstrap (normally your root `.env` value for `BOOTSTRAP_TENANT_ID`). Restart Vite after changing it, then run `npm run dev` in web. Vite proxies `/api` to localhost:3000 (API_TARGET may override). The tenant UUID is public build configuration, never a secret or authorization mechanism. Authentication verifies membership in the backend.

For controlled fixtures, set NODE_ENV=test (or development), DATABASE_MIGRATION_URL to a database whose name ends in _test or _dev, SEED_TENANT_ID and SEED_PASSWORD (12–128 characters); run `npx tsx scripts/seed-console.ts` from root. This inserts one `ROLE@console.test` account per role (lowercase), and resets only their test passwords on retry. Never target real data. The script refuses production and missing passwords.

## Diagnose invalid credentials locally

The sign-in email/password must belong to an active user in the exact configured tenant and database. Bootstrap does not reset existing passwords; changing `BOOTSTRAP_ADMIN_PASSWORD` in `.env` does not change a saved account.

From the project root, run `npm run auth:check`. This read-only local administrator command checks the development frontend env files (including Vite's local/mode overrides), compares the tenant with `BOOTSTRAP_TENANT_ID` if present, and queries the configured migration database inside a read-only, tenant-scoped transaction. It reports a missing tenant, missing/inactive account, password mismatch or matching credentials without printing passwords, hashes, user details or database URLs. It makes no database changes.

The email comes from `AUTH_CHECK_EMAIL`, falling back to `BOOTSTRAP_ADMIN_EMAIL`. The optional password comes from `AUTH_CHECK_PASSWORD`, falling back to `BOOTSTRAP_ADMIN_PASSWORD`. If necessary, set `AUTH_CHECK_PASSWORD` locally in the ignored root `.env`, run the check, then remove it. Quote env values containing `#` so dotenv does not treat part of the password as a comment. Never put a password in a `VITE_` variable or share `.env` contents. If no password is supplied, the command checks the account only. It reads configuration files, not an already-running Vite process: restart Vite after corrections. Confirm the running API uses the same database checked by the command; a production build embeds its tenant at build time.

If an existing password is unknown, use an authorized administrator recovery process or provision a different development admin email in the same saved tenant with bootstrap. Do not generate a new tenant UUID or reset/delete the database to repair an existing login. The public login response intentionally remains generic.

## Session/security

POST /api/v1/auth/session accepts the existing login body and issues an HttpOnly, SameSite=Strict cookie; Secure is enabled in production. GET returns `{user:{id,tenant_id,full_name,email,role,active},expiresAt}`; DELETE clears the cookie. Every unsafe cookie-authenticated API request, browser login and logout requires an exact CORS_ORIGINS Origin. Login returns no token to JavaScript. Nothing is stored in localStorage/sessionStorage. Startup loads the session, expiry and any API 401 clear the React Query cache and redirect to login. Intended routes are held in router state, with query/fragment removed and role allowlisting on return. No silent refresh is available; log in again at expiry. Logout cannot revoke a copied stateless JWT, which remains valid until expiry; browser cookie removal and cache clearing are immediate. A network failure during logout shows a retry warning; do not leave a shared browser until server sign-out succeeds.

No reset, first-login change, account lockout or login CAPTCHA exists in this backend. Disabled and invalid users have the same 401. UI handles 423 if a future server supplies it and 429/network errors distinctly. Password help directs users to their administrator. No fabricated reset route or CAPTCHA widget is shown.

Open tabs synchronize sign-out and account changes using BroadcastChannel event names only; no tokens or personal data are sent between tabs. Focus, pageshow and returning to a visible tab revalidate the HttpOnly-cookie session with the backend, including when BroadcastChannel is unavailable. A changed user, tenant or role clears cached data before the new session is shown. Failed revalidation hides the previous user until retry succeeds. A local or broadcast sign-out suppresses automatic revalidation so a failed server logout cannot silently restore the old account; explicit sign-in or a sign-in notification from another tab resumes it.

## Branding and UI

Branding uses the original Suretek logo embedded in the supplied blueprint and the primary red (#a22426), Poppins body font and Teko display font from https://www.suretekinfosoft.com/. `src/tokens.css` centralizes the palette, spacing and type. Fonts are self-hosted, with their licenses and asset provenance in `src/assets/README.md`. The shell follows the document’s white header/sidebar, red active navigation and bordered white cards. Login shares that branding and hides the introduction panel on narrow screens so the form stays easy to reach at 360px. The shared shell has a sidebar, account menu, role-specific overview, disabled coming-soon items and cards. Profile-only roles have an empty-workspace card. Forbidden, missing page, session-expired notice, startup loading/retry and error-boundary states use the same typography. User content is React-escaped; no HTML injection or client logging/error telemetry is used.

## Build/release and server

Set repository Actions variable PILOT_TENANT_ID to the actual tenant UUID before publishing a v*._._ tag. It becomes the VITE_TENANT_ID build argument in the tagged Caddy companion image. The multi-stage image installs/builds web then copies only dist into `/srv/console`; API and edge use the same release tag. No new host ports. Caddy preserves automatic HTTPS, docs blocking and hardening. `/console/*` uses SPA fallback, self-only scripts/styles/connect CSP with no inline scripts, immutable hashed assets and no-store HTML. Login does not use CAPTCHA, so no third-party CSP allowlist is needed. Add the console HTTPS origin to CORS_ORIGINS, deploy both images, verify Secure/HttpOnly cookies, POST Origin rejection, expiry/logout, CSP and cache headers. Existing deploy/smoke.sh also loads the console login document; full applicant smoke still requires its existing inputs. Clear old cached HTML on upgrade if an earlier proxy cached it.

## Tests

`npm run lint`, `format:check`, `typecheck`, `test`, `build`. For real-backend E2E set the credentials required by `deploy/compose.e2e.yaml`, the same SEED_TENANT_ID/VITE_TENANT_ID and SEED_PASSWORD. Run `docker compose -f deploy/compose.e2e.yaml up -d --build --wait api`, `npx playwright install chromium`, then `npm run e2e` in web. This uses a disposable PostgreSQL backend and real login throttling (tests wait between groups). Stop with `docker compose -f deploy/compose.e2e.yaml down -v`. Never use production credentials. Screenshots/traces/video are disabled to avoid credential/PII artifacts.

Dependencies: React/ReactDOM render the shared UI; React Router manages guarded routes/history; TanStack Query owns cached API data and logout clearing; react-hook-form manages accessible form state; zod and @hookform/resolvers validate form/server shapes. Vite/TypeScript compile assets; Vitest/jsdom/Testing Library test browser state; Playwright tests real-backend journeys; ESLint/Prettier enforce consistency. No UI component or telemetry library was added.
