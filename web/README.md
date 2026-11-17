# Suretek HireAI console

The `/console` app supports SaaS organization provisioning and email-based onboarding. Super Admin has only **Organizations**. Organization Admin (`HR_ADMIN`) has **Team & invitations**, its role home and existing coming-soon business navigation. Other roles have their existing permission-filtered homes. Recruitment/HR business screens remain unbuilt. See [SaaS setup, APIs, security and upgrade notes](../docs/saas-onboarding.md).

## Development

Use Node 24 and install locked dependencies in root and web with `npm ci`. Configure PostgreSQL, the migration connection and runtime app role as in the root README. Run migrations including 012, then create the first platform owner with `npm run bootstrap:platform` using a dedicated platform UUID and slug `platform`. Existing organization data is not automatically promoted. Keep `CORS_ORIGINS=http://localhost:5173` for Vite's same-origin API proxy. Set up authenticated TLS SMTP (a local TLS test mailbox is suitable for development); the log/disabled adapters never send or expose invitation tokens.

From `/web`, run `npm run dev` and open http://localhost:5173/console/login. Use organization key `platform` for the platform owner, or the key in an organization invitation. One web build supports all organizations: no `VITE_TENANT_ID` or release `PILOT_TENANT_ID` is needed. `web/.env.example` can be copied to `.env.local` to set an optional default `VITE_ORGANIZATION_SLUG`. Restart Vite after editing it. The tenant UUID is internal database configuration; users never enter one. Vite proxies `/api` to localhost:3000 (`API_TARGET` may override).

For controlled fixtures only, set NODE_ENV=test (or development), DATABASE_MIGRATION_URL to a database ending in _test or _dev, SEED_TENANT_ID and SEED_PASSWORD (12–128 characters); run `npx tsx scripts/seed-console.ts` from root. It creates one account per role, with Super Admin in a separate platform tenant (`SEED_PLATFORM_TENANT_ID`, optional) and all other roles in `console-test`. Never seed production. These test users use the env password; real customer users set their own password via invitation.

## Diagnose invalid credentials locally

From root, set `AUTH_CHECK_ORGANIZATION` to the organization key used on the sign-in form, then run `npm run auth:check`. It also accepts `AUTH_CHECK_EMAIL` (fallback BOOTSTRAP_ADMIN_EMAIL) and optional `AUTH_CHECK_PASSWORD` (fallback BOOTSTRAP_ADMIN_PASSWORD). Temporarily set values locally in the ignored root env and remove passwords after checking. It uses the migration database connection in a read-only tenant transaction and reports a missing organization/account, inactive account, password mismatch or matching credentials. It never prints passwords, hashes, emails or connection URLs, changes data, or resets a password.

Bootstrap retains an existing account's saved password. Editing BOOTSTRAP_ADMIN_PASSWORD does not reset it. An invited user must first accept the latest, unexpired invitation. Quote env values containing `#`, confirm the API uses the same database and restart Vite after configuration changes. Never put a password in a `VITE_` variable or share `.env` contents.

## Sessions and invitations

Browser login accepts organization key/email/password and issues an HttpOnly, SameSite=Strict cookie (Secure in production). All unsafe cookie-authenticated requests, session login/logout and invitation acceptance require an exact allowed Origin. Session GET returns user/organization/expiry without a JWT; DELETE clears the cookie. Credentials are never persisted in localStorage/sessionStorage. Startup loads the session; expiry/401 clears cached data and redirects to login. Intended paths are held in router state with query/fragment removed and role allowlisting on return.

BroadcastChannel event names synchronize logout/account changes; no personal data or credentials are broadcast. Focus/pageshow/visibility revalidate the backend session, clear stale identity caches and hide stale user data on error. Explicit logout suppresses automatic sign-in even if server logout fails. The UI warns and offers retry for a failed server logout. Stateless copied JWT revocation and silent refresh remain unsupported.

Invitation links carry a random one-time token in a fragment, which the acceptance page immediately removes from history. Tokens/passwords remain only in memory and are sent in a POST body. The user sets/ confirms a 12–128-character password, then proceeds to the organization-prefilled sign-in page. Only the server fixes the invited tenant/user/role. Expired, used, cancelled and replaced links show a recovery message. Organization admins may resend/cancel staff invitations and manage accepted staff status. A delivery failure is shown explicitly and can be retried without duplicating an organization/account. General forgotten-password/reset, forced legacy password change, CAPTCHA and login lockout flows are not implemented.

## Branding

The original logo comes from the supplied Suretek blueprint. Primary red #a22426, Poppins body font and Teko display font come from https://www.suretekinfosoft.com/. `src/tokens.css` centralizes palette, spacing and type; local font licenses and asset provenance are in `src/assets/README.md`. White header/sidebar, red active navigation and bordered cards follow the retained document screens. The responsive login/organization/team/acceptance layouts support 360px. User content is React-escaped; no HTML injection or telemetry is used.

## Build and deployment

API and web/Caddy ship in the same tagged release. The Caddy multi-stage image copies only web dist into `/srv/console`; no organization UUID is embedded. Keep HTTPS, exact console origin in CORS_ORIGINS, PUBLIC_WEB_BASE_URL on that same origin, and working authenticated TLS SMTP. Apply migration 012 before running the new API. Bootstrap the dedicated platform owner as an operator, then create organizations through the console. Existing per-organization maintenance jobs require an active organization admin; platform accounts cannot run customer retention/scanning.

Caddy keeps the existing non-root/read-only/no-new-privileges/cap_drop/memory hardening and production published ports. `/console/*` has SPA fallback, self-only CSP (including local fonts), immutable hashed assets and no-store HTML. Docs stay blocked. Verify cookies, Origin rejection, expiry/logout, invitation mail and deployment smoke after upgrade. Test Mailpit and its extra localhost-only test ports are absent from production Compose.

## Tests

Run `npm run lint`, `format:check`, `typecheck`, `test`, `build` in web and the existing root checks. For browser E2E set credentials required by `deploy/compose.e2e.yaml`, SEED_TENANT_ID and SEED_PASSWORD. From root run `bash scripts/prepare-e2e-mail.sh` (creates disposable TLS fixtures under ignored work/), then `docker compose -f deploy/compose.e2e.yaml up -d --build --wait api`. Install Chromium with `npx playwright install chromium`, then run `npm run e2e` in web. The local Mailpit UI/API is http://localhost:8025; SMTP requires test TLS/authentication. The API trusts only the generated test CA via NODE_EXTRA_CA_CERTS, with certificate verification kept on. Production has no such test override.

E2E exercises organization creation, actual invitation delivery, first-password setup, Organization Admin and Recruiter/Hiring Manager/Interviewer login, role restrictions and deactivation, plus every role's shell/session/logout/expiry. Throttle/expiry tests deliberately wait between login groups. Screenshots, traces and video are disabled. Tear down disposable data with `docker compose -f deploy/compose.e2e.yaml down -v`; never use production credentials.

Dependencies: React/ReactDOM render the shared UI; Router handles guarded routes/history; TanStack Query owns API caching and mutation invalidation; react-hook-form/zod/resolvers validate forms. Vite/TypeScript build assets; Vitest/jsdom/Testing Library test lifecycle and forms; Playwright tests real-backend flows; ESLint/Prettier enforce consistency. No new runtime dependency was added for SaaS onboarding.
