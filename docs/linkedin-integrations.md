# Hosted OAuth and LinkedIn publishing

Apply migrations through **019**, rebuild API and web, and preserve `INTEGRATION_ENCRYPTION_KEY`. Provider availability is controlled by Super Admin; account consent and publishing belong to Organization Admin. Hiring must be enabled for publishing. Existing platform integration routes remain available.

## Provider authorization window

Suretek registers the provider application once. Set the matching server environment variables (never `VITE_` variables):

- `OAUTH_LINKEDIN_CLIENT_ID`, `OAUTH_LINKEDIN_CLIENT_SECRET`
- `OAUTH_GOOGLE_CALENDAR_CLIENT_ID`, `OAUTH_GOOGLE_CALENDAR_CLIENT_SECRET`
- `OAUTH_MICROSOFT_CALENDAR_CLIENT_ID`, `OAUTH_MICROSOFT_CALENDAR_CLIENT_SECRET`

Register the exact redirect URI `https://YOUR_DOMAIN/console/integrations/oauth`, and set `PUBLIC_WEB_BASE_URL=https://YOUR_DOMAIN`. Development needs a redirect URI accepted by the provider. Compose forwards these variables to the API; restart it after changing them. Missing application configuration disables the consent button with a setup explanation. Legacy Google/Microsoft client credentials remain accepted by the API for compatibility.

Enable the provider under Super Admin → Integrations → Available to organizations. Organization Admin selects the provider and environment, clicks **Connect with …**, and signs in at the provider in the authorization window. After consent, click **Complete connection**, then close the window. The original page refreshes its connection list. If popups are blocked, authorization uses the current tab. No provider password or app secret is requested from the organization admin.

OAuth state is tenant/user bound, expires after ten minutes, and is single use. Google/Microsoft use PKCE; LinkedIn uses its documented confidential authorization-code flow. Callback tokens are encrypted server-side. App rotation during consent invalidates that consent attempt. Tenant credentials reference the hosted app rather than storing its secret. Organizations still own their individual grants. Revoked/expired LinkedIn grants without renewable access require reconnecting.

## Company-page announcements

The LinkedIn application needs approved Community Management access and `rw_organization_admin` / `w_organization_social`. A basic Sign In with LinkedIn application alone is insufficient. Consent must be granted by a member with an eligible role on the company page. See [LinkedIn authorization](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) and [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api).

Connect and test sandbox and production, then enable production. Sandbox verification only reads metadata; it does not create a test post. These environment labels do not create a separate LinkedIn sandbox. Under **Publish jobs to LinkedIn**, choose a published HireAI job, Company-page announcement, an authorized page, the public HTTPS application URL and optional announcement text. Preview, review, and explicitly confirm. Page permissions are checked again before dispatch. A successful post receipt produces a link to the public post.

**Who posts:** once an HR Admin has connected and enabled the company page,
HR Admins and recruiters both post published jobs to it (Jobs → **Publish** or
**Post to channels**), choosing among the pages the connection may post for.
The profile connection is different: it posts on the LinkedIn profile of the
person who connected it, so only they can post with it. Deleting a LinkedIn
post stays with HR Admins.

**The apply link:** LinkedIn posts (company page and profile) link to the
job's HireAI apply page, and the post text ends with "Apply here: <link>". It's
filled in automatically when HireAI runs on a public https:// address; enter
another application page only if candidates should apply elsewhere. On a local
http:// address, enter a public https:// link yourself, since LinkedIn and
candidates can't reach localhost.

## Actual LinkedIn Jobs listings

Jobs listings use a separate partner-approved API and client-credentials authorization, not the member consent window. Do not set `LINKEDIN_JOBS_APPROVED=true` until LinkedIn has granted the applicable access and customer onboarding is complete. [LinkedIn Job Posting API overview](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview) describes restricted partner access; [job synchronization](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/sync-job-postings) describes customer migration requirements. Application approval cannot be implemented or bypassed in this repository.

After approval:

1. Set `LINKEDIN_JOBS_APPROVED=true`. API version defaults are `LINKEDIN_JOBS_VERSION=202604` and `LINKEDIN_MARKETING_VERSION=202611`; maintain supported versions with the partner program.
2. Enable **LinkedIn Jobs** in provider availability.
3. Super Admin opens **LinkedIn Jobs partner setup**, supplies the organization UUID, authorized LinkedIn company URN and partner-issued credentials for each environment. Credentials are encrypted under that organization's context, never returned to the browser. Organization admins cannot choose a different company mapping or save arbitrary partner credentials.
4. Organization Admin tests sandbox and production and enables production. This checks authentication, not permission to create an actual listing. Complete LinkedIn's customer migration/certification requirements separately; a successful token is not certification.
5. Choose LinkedIn Jobs listing and a published HireAI job. It needs a location and a description of 100–25,000 characters. Supply a public application URL, preview, and confirm.

This adapter submits **BASIC CREATE** jobs. Premium slots, Apply Connect, sponsored jobs, updating/closing/renewing listings and automatic synchronization of all jobs are not implemented. Coordinate the customer's complete feed migration with LinkedIn before production use; this individual submission workflow does not satisfy every partner onboarding requirement by itself.

A receipt means **SUBMITTED**, not live. Use **Check LinkedIn status** after processing (LinkedIn recommends checking after about five minutes). **PROCESSED** means migration processing without confirmed publication and can be checked again; **PUBLISHED** requires a successful task result. See [task statuses](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/check-job-taskstatus).

## Delivery and recovery

Preview does not publish. A preview expires after ten minutes; job edits, connection changes or provider revision changes require a fresh preview. The final dispatch claim checks current provider availability, connection approval and job version. Disabling a provider prevents subsequent claims; it cannot retract an external request already claimed/in flight.

Publication history is tenant scoped and audited. The same publication cannot be sent twice, and an active or successful publication prevents another submission for the same job/channel. Network failures or missing receipts are **UNKNOWN**, never automatically retried. A process crash may leave **SENDING**. Check the company page or LinkedIn partner logs using the publication/job identifiers before any operator reconciliation. There is deliberately no browser reset/retry for uncertain writes. Reconcile with provider evidence using an audited database maintenance procedure; do not clear the duplicate guard merely because a request timed out. Explicit provider rejection is **FAILED** and a corrected new preview may be submitted.

Tests use mocked provider responses plus real PostgreSQL authorization/RLS checks. No live LinkedIn account authorization or public publication is performed by the test suite. Production acceptance requires approved applications, customer credentials and an explicitly authorized test publication.
