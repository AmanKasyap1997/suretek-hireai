# Super Admin repository audit

Audit completed before implementation, 2026-11-17.

## Existing stack and structure

NestJS 11 / TypeScript, PostgreSQL through parameterized `pg` queries (no ORM), npm lockfiles. React 19 / Vite / React Router, plain CSS and shared Brand/Shell components; React Query, React Hook Form and Zod. Jest/Supertest and PostgreSQL integration tests; Vitest/Testing Library and Playwright on the frontend. Authentication uses scrypt passwords, signed JWTs and HttpOnly same-origin browser cookies, origin validation and Nest throttling.

`src/modules/auth` owns authentication and central deny-by-default role authorization. `src/modules/saas` already provisions organizations and hashed invitations through a narrow database function. `database/migrations` are checksum-protected forward migrations. Tenant-owned tables already have indexed `tenant_id`, composite foreign keys and forced PostgreSQL RLS. `web/src/App.tsx` owns routes/layout/sidebar; `permissions.ts` centralizes menus. Business controllers exclude Super Admin. `audit_events` is append-only for the runtime role. SMTP and invitation delivery status already exist.

## Gaps and risks

Only organization creation/list/resend exists in the platform UI. No lifecycle, modules, aggregate reports, platform settings or encrypted provider management. Users have one primary role, no last-login or forced password rotation. Login and guards do not check organization suspension. Platform directory currently excludes legacy organizations. Never broaden business RLS to expose candidate/employee records to platform users. Provider testing must use fixed endpoints, never an arbitrary client URL (SSRF). External email must follow transaction commit, since SMTP cannot participate in a database rollback. Do not inspect or copy local secret env files.

## Implementation plan and assumptions

Extend existing tenant model rather than introducing duplicate organizations or an ORM: `tenant_id` is the organization identifier; platform users retain their dedicated platform tenant for existing RLS compatibility. Preserve existing organizations, with defaults, rather than moving records to a new Suretek tenant. Add migration 013, a dedicated Super Admin service/controller/schema, encryption helper, and existing SaaS/auth extensions. Add platform pages within existing Shell, central six-item menu and module guards. Update bootstrap env aliases, README, tests and route snapshots. Add aggregate-only database functions with explicit platform checks and no raw business data. Optional support access stays disabled; document any optional MFA limitation. Run existing lint, tests and production builds; use disposable database integration tests when available. Keep changes in logical commits.

## Review of latest main (8df6ac8), before completion changes

The pushed implementation now supplies migrations 012–015, the Super Admin API and all six console screens, organization lifecycle and invitations, encrypted integration registry, settings, aggregate reports, multi-role membership and forced initial password changes. Existing authorization and RLS remain the foundation; preserve these implementations and the supplied branding.

Concrete gaps found during source review:

- A failed sandbox re-test can leave production enabled; test completion does not serialize with enable/rotation. Close that approval race and invalidate dependent production approval on failure.
- Organization invitation resend can target deleted/suspended organizations. The legacy organization list also includes soft-deleted entries.
- The dashboard omits call-minute limits and treats zero storage quotas and old trial dates on active organizations as warnings.
- The organization audit filter only matches entity IDs, so integration override events are missing from that organization's trail.
- The integrations form imposes the password field's 128-character ceiling on OAuth credentials (API allows 8192); dates are displayed as UTC but submitted as local time; successful detail edits remount their success notice away. Organization filters lack ascending sort, and the global audit viewer lacks an organization selector.
- The verification document linked by the runbook is absent. Several pushed files are not formatted. Existing tests need to be rerun against the latest migrations before claiming completion.

Completion plan: fix the service/state transitions and UI defects in place; add focused unit, API and frontend regression coverage; update operations/scope/API/hardening documentation and record actual validation. Do not implement optional impersonation or partial MFA. Preserve tenant IDs and use forward-only migrations only if schema changes are necessary. Verify the existing production deployment configuration can carry the new encryption/verification settings.
