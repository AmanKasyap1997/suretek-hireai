# Blueprint coverage and extension points

This starter implements the shared backend foundation and a small set of complete staff workflows. The broader Suretek HireAI document and HireAI + HRMS platform map describe a multi-phase product; they are not a claim that all modules are implemented here.

| Blueprint area                  | Starter behavior                                                                                                                       | Remaining work                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Authentication and organization | Tenant-scoped users, login, staff role checks and assignment-scoped manager/interviewer access                                         | SSO, MFA, invitations and richer ownership policies                                  |
| Jobs and publishing             | Requirements, approvals, assignments, local publication and public careers listings                                                    | External careers CMS/job-board publishing and approval routing                       |
| Candidates and applications     | Deduplication, filtered lists, stage evidence, private resume upload/download controls and erasure/retention                           | Resume parsing, rich profiles and candidate portal                                   |
| AI screening and assistant      | Human-controlled hiring decisions; no AI model is called                                                                               | Provider gateway, evidence-based scoring and permission-scoped assistant tools       |
| AI calling                      | Append-only scoped consent, policy-checked planning and cancellation                                                                   | Durable dispatch, provider adapters, dispatch-time checks, retries and cost limits   |
| Call details                    | No recordings or transcripts are generated or exposed                                                                                  | Recording access, encrypted storage, playback, retention and deletion                |
| Interviews and scorecards       | Local scheduling/rescheduling/cancellation, database panelist overlap protection, criteria snapshots and immutable panelist scorecards | External calendar free/busy, invitations, reminders and meeting-link creation        |
| Offers and hire-to-join         | Approval/acceptance evidence, expiry, revision, maker-checker and transactional employee/onboarding creation                           | Candidate-verified acceptance, e-signature and offer documents                       |
| Core HR and onboarding          | Employee records, basic administrative leave/attendance and initial tasks                                                              | Self-service, hierarchy, richer policies, balances, rosters and biometrics           |
| Payroll and compensation        | Offer CTC carried into employee record                                                                                                 | Statutory calculations, payroll runs, bank files and settlements                     |
| Performance, LMS and engagement | No implementation                                                                                                                      | Goals/reviews, training, surveys, recognition, helpdesk and assets                   |
| Audit and reporting             | Transactional audit evidence and indexed stage-event funnel/dwell/time-to-hire reports                                                 | Exports, scheduled reporting and wider HR analytics                                  |
| Integrations                    | Private local/S3-compatible storage, disabled CAPTCHA/malware ports and calendar stub                                                  | Real scanning/CAPTCHA/calendar providers, OAuth, signed webhooks and outage handling |

## Data and workflow rules

- An authenticated user's database membership determines the tenant and role. No route grants cross-tenant access to a super administrator.
- PostgreSQL composite foreign keys reject references to records in another tenant.
- Administrative role checks do not substitute for candidate/employee ownership or actual interview panel membership. Candidate and employee portals remain unfinished.
- Shortlisting, rejection, offer approval and acceptance recording require staff actions. AI does not choose a hiring outcome.
- The accepted-offer conversion locks the offer and commits employee creation, onboarding tasks and audit data together. Unique source-offer and candidate constraints prevent duplicate employee records.
- Call, recording and transcription consents are independent, append-only evidence records. A planning record is not evidence that a real call is compliant or authorized at dispatch time.
- Local job publication and staff-recorded offer acceptance are internal workflow states, with no external CMS publication or identity-verified candidate signature.

## Suggested implementation order

1. Connect and validate a real malware scanner before enabling resume downloads; review intake notices and retention policy.
2. Add an external calendar adapter to the existing local scheduling workflow and candidate-verified offer acceptance.
3. Add a model gateway with structured screening evidence and human review.
4. Implement a durable dispatch worker and sandbox telephony adapter with dispatch-time consent/policy checks.
5. Add report exports and scheduling from verified event metrics.
6. Expand employee self-service and HR policies before payroll or later HRMS phases.

Production integration choices and statutory payroll/telephony requirements require validation for the actual providers and deployment jurisdiction. This repository does not reproduce or validate prices from the planning document.

## Milestone A delivered

Job requirements, assignment-scoped manager/interviewer visibility, stage history, reasoned rejection, offer revision/expiry/maker-checker and filtered lists are implemented. Migrations 004 and 005 are forward-only additions; the enum snapshot includes assignments, employment types, event stages and rejection reasons. Existing job/application state machines remain human-controlled. Milestones B and C extend this foundation below; AI/queue/provider work remains outside these milestones. [Roadmap](talent-acquisition-plan.md).

## Milestone B delivered

Public published-job browsing and generic application intake are tenant-resolved without RLS bypass. Independent self-reported consent choices carry notice/IP/timestamp/user-agent evidence and do not replace staff-verified consent. Private PDF/DOCX uploads use local development storage or a signed S3-compatible adapter, with mandatory CLEAN scan status for audited API downloads. The malware/CAPTCHA ports are explicit stubs; there are no real scan/CAPTCHA provider calls. Admin erasure and a tenant-scoped retention CLI anonymize candidates, revoke consent, cancel planned calls and retry private document deletion while preserving evidence. See [operations](milestone-b-operations.md). Milestone C extends this foundation below; the listed non-goals remain unimplemented.

## Milestone C delivered

Interview reservations use tenant-scoped composite relationships and database exclusion constraints to reject overlapping active reservations for the same panelist. Staff manage schedules; panel members receive scoped visibility and submit immutable scorecards against frozen criteria. The CalendarPort/DisabledCalendar pair is a stub only and no API calls it. Scheduling and recommendations never change application stages or hiring outcomes.

Admin/recruiter reports derive funnel entries, clipped nonterminal stage dwell and first-APPLIED-to-first-HIRED duration from stage evidence. Query periods are bounded; incomplete legacy hire histories are excluded and counted rather than assigned zero duration. See [definitions and verification](ta-milestone-c-report.md).

## Milestone D readiness

ClamAV scanning and a bounded cron sweep, permanent infected-document quarantine, explicit production storage/scanner/CAPTCHA choices, real MinIO protocol tests, hashed single-use contact verification and Turnstile are implemented. See [readiness operations](milestone-b-operations.md#milestone-d-readiness) for configuration, local-volume persistence, verification limitations and real ClamAV checks. Email delivery remains a development log adapter; production needs an EmailPort provider before contact verification can be used. Email/client rate buckets are charged after validation and CAPTCHA, preventing unrelated clients from exhausting a victim's email allowance.
