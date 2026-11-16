# Talent Acquisition Milestone C report

Implemented on `feature/ta-milestone-c`: local interviews, immutable scorecards, a disabled calendar port and recruitment reports. Final verification passed 137 tests in 21 suites and one route snapshot. The 116-test A/B baseline remains passing; all 64 existing route contracts are preserved and 10 C routes are added, for 74 total.

## Delivered behavior

- Staff schedule, reschedule, list, inspect and cancel local interviews. Creation and rescheduling require a non-erased candidate and an application in SHORTLISTED or INTERVIEW. Creating an interview requires 1–20 distinct active tenant panelists, future offset-aware timestamps, positive duration up to 24 hours, and a mode of VIDEO, PHONE or ONSITE. VIDEO needs a supplied HTTPS meeting URL; ONSITE needs a location. No meeting URL is generated.
- Database exclusion constraints prevent overlapping active reservations for the same panelist. Intervals are `[start,end)`, so adjacent interviews are valid. Concurrent conflicts return 409. Cancellation is idempotent and releases reservations.
- Each interview freezes the job's criteria. Panelists submit one immutable scorecard with all frozen criterion IDs, integer scores 0–5, a recommendation and bounded notes. Staff can read the interview's cards; manager/interviewer users see only their own submitted cards. Even an administrator must be a panelist to submit. Cancelled interviews reject submissions; removing an already submitted panelist conflicts.
- Interview and scorecard operations never change an application stage or decide a hiring outcome. The CalendarPort/DisabledCalendar contract is provided, but the API does not call it or any external calendar provider.
- Recruiter/admin reports aggregate append-only stage evidence. The existing hiring-summary endpoint is unchanged.

## Report definitions

Routes are GET `/api/v1/reports/recruitment/funnel`, `/time-in-stage` and `/time-to-hire`. Only SUPER_ADMIN, HR_ADMIN and RECRUITER have access; manager/interviewer assignments do not grant report access. An unknown or foreign-tenant `jobId` returns 404.

Queries accept only optional `jobId` (UUID), `from` and `to` (ISO timestamps with a timezone). The period is `[from,to)`, must be positive, and cannot exceed 366 days. The default `to` is the current instant; omitted `from` means 30 days before `to`. Timestamps in the response are normalized to UTC. Every response has `period`, `asOf` and `data`. Future requested end times are observed only through `min(to,asOf)`, with no projected stage duration. Empty groups are omitted, and durations are seconds, including fractional seconds where recorded.

| Report        | Definition                                                                                                                                                                                                                                                                              | Data fields                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Funnel        | Count distinct applications with a `to_stage` event in the period, per job and stage. Repeated entries into the same stage count once per application. Counts are stage entries, not necessarily a monotonically decreasing conversion funnel.                                          | `jobId`, `jobTitle`, `stage`, `applicationCount`                                                 |
| Time in stage | Order all application events by `created_at,id`; use the next event as the end of each visit. Clip visits to the period and observed end. Exclude HIRED/REJECTED dwell and nonpositive overlaps. Count repeated visits separately; average over visits, not over distinct applications. | `jobId`, `jobTitle`, `stage`, `applicationCount`, `visitCount`, `totalSeconds`, `averageSeconds` |
| Time to hire  | First APPLIED event to first HIRED event across the application's full history, where the first HIRED is in the period. Require APPLIED evidence no later than HIRED. A group without valid hires has no output row.                                                                    | `jobId`, `jobTitle`, `hireCount`, `totalSeconds`, `averageSeconds`, `minSeconds`, `maxSeconds`   |

Time-to-hire responses also include `excludedHiresMissingApplied` and `excludedHiresInvalidOrder`. These count in-period first hires omitted for missing APPLIED evidence or reversed chronology. A legacy hired application without an initial APPLIED event is never assigned a zero-day duration. An actual zero duration remains valid when both events are recorded at the same instant.

Stage events are authoritative. Migration 004 reconstructed a single then-current stage at `application.created_at`; it did not recover earlier transitions. Reports over those legacy snapshots, especially dwell, are approximate. Later recorded transitions have their actual event timestamps. Candidate anonymization preserves stage evidence and these aggregates contain no candidate contact fields.

The existing chronological index and new tenant/event-date reporting index support the queries. A bounded period does not bound the total historical scan: dwell needs preceding state and time-to-hire needs initial history. Profile larger tenants before introducing materialized aggregates or other optimizations.

## Database and access controls

Migration 008 adds interview, panelist and scorecard tables with composite tenant relationships, forced RLS, precise runtime grants and database overlap protection. Migration 009 synchronizes new enum values through the existing workflow. Historical migrations 001–007 remain unchanged. The owner provisions the trusted PostgreSQL `btree_gist` extension for the exclusion constraint; no runtime npm dependency is added.

Only active same-tenant panelists with eligible global roles can be scheduled. Staff recruitment roles manage schedules. Hiring managers/interviewers need actual panel membership for interview detail/list visibility; an unrelated resource is hidden with 404. Scorecard submission derives the author from the verified actor and writes its audit event in the same transaction. The application database role has no scorecard update/delete privilege.

## Schema changes

| Object                                   | Purpose and enforcement                                                                                                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `interviews`                             | Application relationship, round/mode/times/status, immutable criteria snapshot, tenant-scoped composite keys and schedule indexes.                                                                                   |
| `interview_panelists`                    | Unique interview/user membership; reservation times/status follow the parent schedule through a composite cascading foreign key; GiST exclusion rejects overlapping SCHEDULED reservations for the same tenant/user. |
| `interview_scorecards`                   | Unique interview/panelist submission, JSON scores, recommendation and notes; composite foreign key preserves the actual panel membership; app role has SELECT/INSERT only.                                           |
| `application_stage_events_reporting_idx` | Tenant-first event-date/application/stage index supporting report period filters alongside the existing chronological index.                                                                                         |
| Canonical enums and snapshot             | Add `InterviewMode`, `InterviewStatus` and `ScorecardRecommendation`; generated migration 009 applies their CHECK constraints.                                                                                       |

All three new tenant tables enable and force tenant RLS. Migration 008 provisions the trusted `btree_gist` extension as the owner; the app role receives no extension/DDL privilege. Migrations 001–007 remain byte-for-byte unchanged.

## Resolved ambiguities

- Reservations use half-open intervals and instants rather than local clock labels. Adjacent slots are allowed; interview duration is limited to 24 hours. Creation or changing schedule times requires a future start; venue/panel-only updates do not revalidate the original start time.
- Creation/rescheduling requires a non-erased candidate and a SHORTLISTED or INTERVIEW application. Cancellation can release an existing slot even after that eligibility changes.
- Actual interview panel membership controls scoped manager/interviewer visibility. Staff manage schedules, but even staff must be panelists to author scorecards. Manager/interviewer scorecard reads expose only their own submissions.
- Criteria are frozen at scheduling and remain unchanged by rescheduling or later job edits. Submission is immediately immutable and has no interview-completion/start-time gate; a separate completion workflow is outside this milestone.
- Only SCHEDULED and CANCELLED interview states are introduced. Cancellation releases reservations and blocks new submissions; a submitted panelist cannot be removed. No interview or recommendation automatically changes an application stage.
- Calendar operations remain an uninvoked disabled port. A supplied video URL is manual, and the API creates no calendar event, invitation or meeting link.
- Report periods default to 30 days, allow at most 366 days, and use first stage evidence for hire timing. Legacy missing/reversed APPLIED evidence is counted as excluded; reconstructed historical dwell and full-history scan limits are disclosed above.

## A/B corrections reviewed with C

Compose now forwards storage, intake, retention and maker-checker variables to its production API. Docker startup requires HTTPS S3 storage with a private bucket and credentials; host development can continue using local private storage. Empty optional S3 session tokens are treated as omitted.

Public intake validates resume bytes/size before identity-dependent duplicate handling, preventing different validation outcomes from identifying an existing application. DOCX validation now checks local/central headers, bounded expansion, payload integrity and CRC using built-in facilities. The scanner still returns PENDING and CAPTCHA remains a disabled port. Existing retention locking was reviewed; no unsupported new retention workflow is claimed.

## Acceptance results

| Check                                                     | Result                                                                                                                                                         |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`                                                  | Passed with the lockfile; no new runtime dependency.                                                                                                           |
| `npm run enums:check`                                     | Passed.                                                                                                                                                        |
| `npm run lint`, `npm run format:check`, `npm run build`   | Passed.                                                                                                                                                        |
| Fresh PostgreSQL owner migrations 001–009, then retry     | Passed on `hireai_ta_c_acceptance`; second run skipped all applied migrations.                                                                                 |
| Existing A/B database upgrade through 008–009, then retry | Passed without editing historical migrations.                                                                                                                  |
| `npm test`                                                | 21 suites, 137 tests and 1 route snapshot passed. The 116-test A/B baseline remains passing.                                                                   |
| Route contracts                                           | All 64 existing contracts preserved; 10 C routes added, 74 total.                                                                                              |
| Existing test preservation                                | All 116 prior full test names pass; source comparison confirms 83 original static test callback bodies unchanged and no assertion reductions.                  |
| Database/RLS/immutability/overlap checks                  | Passed, including missing-context reads across all three new tables, tenant isolation, concurrent reservation conflicts and denied scorecard update/delete.    |
| Docker image build                                        | Passed for final source. The local proxy required a session-only CA secret mount; TLS verification stayed enabled and the repository Dockerfile was unchanged. |
| Production image smoke                                    | Passed as nonroot: database readiness 200, disabled Swagger 404, unauthenticated C route 401, with valid private-S3 configuration and no storage request.      |

Verification used separate owner, restricted app and test-admin database connections. The main acceptance commands were:

```bash
npm ci
npm run enums:check
npm run lint
npm run format:check
npm run build
npm run db:migrate
npm run db:migrate
npm test
```

Migrations were also run twice on the existing A/B database. The Docker build used the same repository context with only an ephemeral BuildKit CA mount added in the session's temporary Dockerfile. The committed Dockerfile and TLS settings were unchanged; GitHub CI will build that original Dockerfile and remains pending at the time of this report.

## Verification limits

No production migration or deployment was performed. No real S3 bucket, bucket policy, backup/replica lifecycle, external calendar, malware or CAPTCHA service was exercised. The production smoke check validated S3 configuration only; existing storage protocol tests use a local signed-protocol server. The scanner still returns PENDING and CAPTCHA is disabled. Scorecard notes and other retained evidence need the organization's retention/access policy alongside the existing candidate erasure policy.

No AI screening, dispatch queue, telephony, candidate portal, payroll or HR self-service is added. Interview completion/reminders and external calendar reconciliation remain future work. Legacy event approximation and historical report-scan limits are described above.

## Changed files

Compared with the merged Milestone B source, including the A/B corrections and C verification/docs:

- `README.md`
- `compose.yaml`
- `database/enums.snapshot.json`
- `database/migrations/008_ta_interviews.sql`
- `database/migrations/009_sync_domain_enums.sql`
- `docs/api-examples.http`
- `docs/blueprint-scope.md`
- `docs/hardening.md`
- `docs/ta-milestone-c-report.md`
- `docs/talent-acquisition-plan.md`
- `eslint.config.mjs`
- `src/integrations/README.md`
- `src/integrations/calendar.ts`
- `src/integrations/index.ts`
- `src/integrations/integrations.module.ts`
- `src/integrations/resume-validation.ts`
- `src/modules/talent-acquisition/careers/careers.service.ts`
- `src/modules/talent-acquisition/index.ts`
- `src/modules/talent-acquisition/interviews/index.ts`
- `src/modules/talent-acquisition/interviews/interviews.controller.ts`
- `src/modules/talent-acquisition/interviews/interviews.module.ts`
- `src/modules/talent-acquisition/interviews/interviews.schemas.ts`
- `src/modules/talent-acquisition/interviews/interviews.service.ts`
- `src/modules/talent-acquisition/reports/index.ts`
- `src/modules/talent-acquisition/reports/reports.controller.ts`
- `src/modules/talent-acquisition/reports/reports.module.ts`
- `src/modules/talent-acquisition/reports/reports.schemas.ts`
- `src/modules/talent-acquisition/reports/reports.service.ts`
- `src/modules/talent-acquisition/scorecards/index.ts`
- `src/modules/talent-acquisition/scorecards/scorecards.controller.ts`
- `src/modules/talent-acquisition/scorecards/scorecards.module.ts`
- `src/modules/talent-acquisition/scorecards/scorecards.schemas.ts`
- `src/modules/talent-acquisition/scorecards/scorecards.service.ts`
- `src/modules/talent-acquisition/talent-acquisition.module.ts`
- `src/platform/config.ts`
- `src/platform/database/enum-schema.ts`
- `src/shared/enums.ts`
- `src/shared/ta-policy.ts`
- `test/__snapshots__/route-contract.spec.ts.snap`
- `test/helpers/api-fixtures.ts`
- `test/helpers/resume.ts`
- `test/integration/ta-milestone-b.spec.ts`
- `test/integration/ta-milestone-c-interviews.spec.ts`
- `test/integration/ta-milestone-c-reports.spec.ts`
- `test/resume-storage.spec.ts`
- `test/rls.integration.spec.ts`

## PR description

**Title:** Complete Talent Acquisition Milestone C

Recruiters can schedule local interviews with database-enforced panelist overlap protection, collect immutable criteria-based scorecards, and inspect tenant-scoped funnel, stage-dwell and time-to-hire reports. Panel membership governs scoped access, recommendations remain human inputs, and the calendar adapter stays disabled.

The change also forwards Milestone B production storage/policy settings through Compose, normalizes empty optional S3 tokens, and makes public resume validation consistent while verifying DOCX archive integrity. Additive owner migrations introduce the interview schema and enum constraints; historical migrations and the 64 existing route contracts are preserved.

The trusted PostgreSQL `btree_gist` extension is required for UUID equality within the panelist time-range exclusion constraint. Its migration passed as the `NOSUPERUSER` owner; no new npm runtime dependency is added.

Validation: locked install, enum/lint/format/build checks, fresh and upgrade migration retries, 137 tests across 21 suites with one route snapshot, and a nonroot production-image build/smoke check passed. Ten new C routes bring the contract total to 74. GitHub CI is pending; local Docker needed only an ephemeral session CA mount with TLS verification enabled. No real provider or production deployment was exercised.
