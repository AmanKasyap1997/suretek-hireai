# LinkedIn Jobs

HireAI integrates only with LinkedIn's partner-gated Jobs posting API. Company
feed announcements and LinkedIn member OAuth are not supported. An organization
must have LinkedIn partner access and completed customer onboarding before it can
publish actual listings.

## Partner and organization setup

Do not set `LINKEDIN_JOBS_APPROVED=true` until LinkedIn has approved the required
partner access and customer onboarding. The Job Posting API is restricted;
approval cannot be implemented or bypassed in this repository. See LinkedIn's
[Job Posting API overview](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview)
and
[job synchronization guidance](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/sync-job-postings).

After approval:

1. Configure `LINKEDIN_JOBS_APPROVED=true` and a supported
   `LINKEDIN_JOBS_VERSION` on the API. Keep partner credentials server-side.
2. Enable **LinkedIn Jobs** in Super Admin → Integrations.
3. Use **LinkedIn Jobs partner onboarding** to assign the organization ID,
   LinkedIn organization URN (the Jobs employer mapping), and partner-issued
   customer application credentials for each environment. Credentials are
   encrypted for that organization.
4. The organization admin verifies both environments and enables production.
   This checks authentication, not approval to create a live listing.
5. In the organization Integrations page, choose a published HireAI job and
   provide its public HTTPS career/application page URL. Preview and explicitly
   confirm before submission.

The job appears as a LinkedIn Jobs listing associated with the configured
company. Its Apply action directs applicants to the supplied career URL. HireAI
does not use LinkedIn Easy Apply or Apply Connect.

## Supported scope and status

This adapter submits **BASIC CREATE** jobs. Jobs need a location and a
description of 100–25,000 characters. Premium slots, sponsored jobs, updates,
closing or renewing listings, Apply Connect, and automatic full-feed
synchronization are not implemented. Coordinate the customer's complete feed
migration with LinkedIn before production use; this individual submission
workflow alone does not satisfy every partner onboarding requirement.

A successful API receipt means **SUBMITTED**, not live. Use **Check LinkedIn
status** after processing. **PROCESSED** means LinkedIn is still processing and
does not confirm a live listing; **PUBLISHED** requires LinkedIn to report a
successful task. See LinkedIn's
[task status documentation](https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/check-job-taskstatus).

Publication history is tenant-scoped and audited. The same job cannot be
submitted twice while a prior publication is active or successful. Network
failures or missing receipts are **UNKNOWN** and are never automatically
retried. Check LinkedIn using the publication/task identifiers before an
operator reconciles an uncertain submission. Explicit provider rejection is
**FAILED** and a corrected new preview may be submitted.

Tests use mocked provider responses and PostgreSQL authorization/RLS checks. No
live LinkedIn publication is performed by the test suite. Production acceptance
requires approved partner applications, customer credentials, and an explicitly
authorized test publication.
