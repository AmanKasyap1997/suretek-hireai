# SaaS organizations and invitation onboarding

This user-requested change supersedes F1's original single-tenant / no-platform-admin scope on the same branch. `SUPER_ADMIN` is now the SaaS platform role; `HR_ADMIN` is the Organization Admin role. Role enum strings remain unchanged. A platform account has organization provisioning access and its own session/profile only; it has no recruitment, HR, staff-management or customer-data privileges. Organization admins manage their own staff and existing business APIs. Staff cannot create organizations or invite users.

## First platform owner

1. Back up an existing deployment, then apply the forward-only migrations with `npm run db:migrate` (including `012_saas_organizations.sql`). The migration does not grant platform privileges to any existing tenant or account.
2. In the operator's ignored root `.env`, supply the existing migration-owner database connection and bootstrap values: `BOOTSTRAP_TENANT_ID`, `BOOTSTRAP_TENANT_NAME`, `BOOTSTRAP_TENANT_SLUG=platform`, `BOOTSTRAP_ADMIN_NAME`, `BOOTSTRAP_ADMIN_EMAIL`, and a unique `BOOTSTRAP_ADMIN_PASSWORD` of 12–128 characters. Choose a dedicated, stable platform UUID.
3. Run `npm run bootstrap:platform`. This is an operator-only database bootstrap, not a public registration API. It creates the platform tenant and first Super Admin. A retry reuses the saved UUID and retains an existing account's password. Remove the password after use.
4. Open `/console/login`, enter organization key `platform`, and use that platform owner's email/password. No tenant UUID or role picker is required in the browser.

Only one platform tenant is allowed. For an existing, otherwise-empty bootstrap tenant containing only Super Admin accounts, the explicit platform bootstrap may promote it. It refuses to promote an existing organization containing staff, jobs, candidates or employees; use a fresh platform UUID and preserve that business organization's data. Legacy Super Admin rows are never automatically upgraded to global platform authority. Normal `npm run bootstrap` is an operator-only organization-admin bootstrap; fresh users created by it are HR_ADMIN, not platform owners.

For production Docker, use the owner-only migration service and the existing mode-600 external bootstrap env file pattern in `deploy/README.md`, but invoke `node dist/scripts/bootstrap-platform.js` with a dedicated platform UUID. Keep the database-owner connection out of the API container. Do not change a business tenant's maintenance IDs to the platform tenant: document scanning and retention still run per organization, with an active Organization Admin actor. Configure those operations for each organization before its production onboarding; backup remains database-wide.

## Email and invitations

Configure authenticated TLS SMTP before onboarding customers:

```env
EMAIL_ADAPTER=smtp
PUBLIC_WEB_BASE_URL=https://your-console-domain.example
SMTP_HOST=your-smtp-host
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASSWORD=your-smtp-password
SMTP_FROM=invites@your-domain.example
INVITATION_TTL_SECONDS=86400
```

`SMTP_SECURE=false` uses mandatory STARTTLS; true uses implicit TLS. Certificate verification remains enabled. `PUBLIC_WEB_BASE_URL` is the same HTTPS origin serving `/console`; include that exact origin in `CORS_ORIGINS`. Default invitation lifetime is 24 hours, configurable from 60 seconds to 7 days. No passwords are emailed.

`EMAIL_ADAPTER=log` and `disabled` do not send invitations or log their secrets. The UI reports failed delivery and offers resend; an organization/account remains visibly pending so an operator can fix SMTP and retry without creating duplicate customers. If delivery times out after SMTP has accepted an email, use the latest resent invitation. No background email queue or automatic retries are introduced.

Super Admin creates an organization (name and unique sign-in key) plus its initial admin (name/email). A single database transaction creates the tenant, inactive HR_ADMIN, hashed invitation and creation audit records. Only after commit is the invite sent. The organization admin follows the email link, sets and confirms a password, then signs in. The organization key is prefilled from the invitation.

Organization Admin opens **Team & invitations** to invite Recruiters, Hiring Managers, Interviewers, Candidates, Employees, Reporting Managers, Payroll/Finance staff or IT/Asset admins. This does not grant record assignments: hiring managers/interviewers still require existing job/panel assignments before accessing records. Organization admins cannot provision platform accounts or other organization administrators. Pending invitations can be resent or cancelled. Accepted staff can be deactivated/reactivated. A cancelled, never-accepted invitation requires an explicit new invitation; an accepted/deactivated account cannot be silently reactivated through resend.

Invitation links use `/console/accept-invitation#organization=KEY&token=SECRET`. The fragment is removed from browser history immediately after it is read into memory. The client submits the token and password in a POST body; it never stores them in localStorage/sessionStorage or sends a role/user ID chosen by the recipient. Tokens have 256 bits of randomness; only SHA-256 hashes are stored. Acceptance checks tenant, pending account, expiry, cancellation and prior use while locking the account/invitation. Acceptance activates the fixed role and records an audit event. Concurrent acceptance succeeds only once. Resend rotates the token and invalidates every previous pending link. Origin checks, rate limits and no-secret logging apply.

## Sign-in and APIs

One web build serves every organization. `VITE_TENANT_ID` and the release repository variable `PILOT_TENANT_ID` are no longer used. `web/.env.local` may set an optional `VITE_ORGANIZATION_SLUG=platform` default; customers enter their own organization key or follow the invitation email. Accounts with the same email in different organizations remain distinct.

`POST /auth/login` and `POST /auth/session` accept `{organizationSlug,email,password}`. Legacy bearer/browser clients may still send `{tenantId,email,password}`; exactly one tenant identifier is required. Passwords and active membership are verified against the resolved organization. `/auth/me` and `/auth/session` add organization name/key and a platform-admin flag. Existing generic login errors, HttpOnly cookie behavior and cross-tab session/cache handling remain.

New API paths (all prefixed `/api/v1`):

| Path                                          | Role / behavior                                                      |
| --------------------------------------------- | -------------------------------------------------------------------- |
| GET /saas/organizations                       | Platform Super Admin, paginated owned organization metadata          |
| POST /saas/organizations                      | Platform Super Admin, create organization + initial admin invitation |
| POST /saas/organizations/:id/admin-invitation | Platform Super Admin, resend initial admin invite while not accepted |
| GET /saas/users                               | Organization Admin, paginated current-organization members           |
| POST /saas/invitations                        | Organization Admin, invite explicitly permitted staff roles          |
| POST /saas/users/:id/invitation               | Organization Admin, resend a staff invitation                        |
| POST /saas/invitations/accept                 | Public one-time acceptance, exact Origin and rate limit              |

Existing PATCH /auth/users/:id/status now permits only Organization Admin managing staff within the same organization. Pending accounts cannot be manually activated. Legacy POST /auth/users remains organization-admin/staff-only for trusted API compatibility; the web UI uses email invitations and never asks the administrator to choose a staff password. Super Admin was deliberately removed from every business API role group and the route contract snapshot records that requested permission change.

`npm run auth:check` remains read-only. Set `AUTH_CHECK_ORGANIZATION` to the same key entered on the login form and, if needed, `AUTH_CHECK_EMAIL` / `AUTH_CHECK_PASSWORD` in the ignored root env. It resolves the organization, checks the scoped account and reports safe status messages. Remove temporary passwords after checking. It does not reset existing credentials.

## Database boundaries and verification

`user_invitations` and `platform_organizations` have forced RLS, tenant-first indexes and `tenant_isolation` policies. The platform directory is scoped to the platform tenant and stores organization-creation metadata only. Its cross-scope links deliberately use `(organization_id,admin_user_id)` and `(organization_id,last_invitation_id)` composite foreign keys to the created organization's records; they do not make those records readable in the platform scope.

The runtime cannot INSERT tenants directly, change `is_platform`, or bypass/own RLS tables. The narrowly granted `provision_organization` function checks an active Super Admin in the platform tenant, establishes the target transaction-local scope, creates only an HR_ADMIN invitation, restores the platform scope and writes metadata/audit. No owner database credentials or unrestricted security-definer scans are added to the API. Platform invitation resend similarly locks its directory record and rotates the target token in one transaction, restoring source scope before updating metadata. All business controllers continue to filter by the authenticated tenant; request bodies cannot choose staff tenant IDs or platform roles.

Acceptance tests cover real PostgreSQL isolation, forbidden platform/business access, duplicate rollback, invitation hashes/expiry/resend/cancellation, pending-account restrictions and concurrent one-time acceptance. SMTP tests use an authenticated TLS server. Browser tests use real PostgreSQL/API plus an authenticated TLS Mailpit test mailbox and complete organization-admin + Recruiter/Hiring Manager/Interviewer onboarding. Test tokens and mailboxes are disposable; screenshots/traces/video remain disabled.
