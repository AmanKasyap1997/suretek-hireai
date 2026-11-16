# Blueprint coverage and extension points

This starter implements the shared backend foundation and a small set of complete staff workflows. The broader Suretek HireAI document and HireAI + HRMS platform map describe a multi-phase product; they are not a claim that all modules are implemented here.

| Blueprint area                  | Starter behavior                                                                                  | Remaining work                                                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and organization | Tenant-scoped users, login and staff role checks                                                  | SSO, MFA, user invitations, richer membership/assignment policies                                                                                              |
| Jobs and publishing             | Draft, approve and mark internally published                                                      | Careers CMS/API adapters, approval routing, public application intake, authorized job-board integrations                                                       |
| Candidates and applications     | Candidate deduplication by tenant/email, paginated staff APIs, manual stages                      | Protected resume upload/download, parsing, rich profiles, candidate portal and search                                                                          |
| AI screening and assistant      | Human-controlled hiring decisions; no AI model is called                                          | Provider gateway, evidence-based scoring, recruiter override evidence, permission-scoped assistant tools                                                       |
| AI calling                      | Append-only scoped consent, policy-checked planning, cancellation                                 | Durable dispatch queue, provider adapters, consent recheck before dialing, retries, concurrency/cost caps, real emergency stop, supervised Hindi/English pilot |
| Call details                    | No recordings or transcripts are generated or exposed                                             | Separate access rights, encrypted storage, provider signature verification, playback, retention and deletion                                                   |
| Interviews                      | Application can enter the interview stage                                                         | Free/busy calendars, idempotent reservations, reminders, rescheduling and scorecards                                                                           |
| Offers and hire-to-join         | Draft/approve/record acceptance, transactionally create one employee and initial onboarding tasks | Secure candidate acceptance, expiry, compensation approval chains, e-signature verification and offer documents                                                |
| Core HR and onboarding          | Employee records, basic admin leave/attendance and initial tasks                                  | Employee self-service, department hierarchy, documents, lifecycle changes, balances/accruals, rosters, biometrics and richer checklists                        |
| Payroll and compensation        | Offer CTC carried into employee record                                                            | Statutory calculations, salary structures, payroll runs, bank files, reimbursements and full/final settlement                                                  |
| Performance, LMS and engagement | No implementation                                                                                 | Goals/reviews, training, surveys, recognition, helpdesk and assets                                                                                             |
| Audit and reporting             | Transactional audit events and initial staff reporting APIs                                       | Report exports, scheduling, verified analytics, retention controls and monitored audit storage                                                                 |
| Integrations                    | No provider credentials required and no external side effects                                     | Adapter contracts, OAuth/secrets, signed webhooks, retry/idempotency semantics and provider outage behavior                                                    |

## Data and workflow rules

- An authenticated user's database membership determines the tenant and role. No route grants cross-tenant access to a super administrator.
- PostgreSQL composite foreign keys reject references to records in another tenant.
- Administrative role checks do not substitute for candidate/employee ownership or interviewer assignment checks. Those portals are intentionally unfinished.
- Shortlisting, rejection, offer approval and acceptance recording require staff actions. AI does not choose a hiring outcome.
- The accepted-offer conversion locks the offer and commits employee creation, onboarding tasks and audit data together. Unique source-offer and candidate constraints prevent duplicate employee records.
- Call, recording and transcription consents are independent, append-only evidence records. A planning record is not evidence that a real call is compliant or authorized at dispatch time.
- Local job publication and staff-recorded offer acceptance are internal workflow states, with no external CMS publication or identity-verified candidate signature.

## Suggested implementation order

1. Add private object storage and signed, authorized resume access; define retention/deletion behavior.
2. Complete careers-site application intake, consent wording and assignment-aware staff access.
3. Add a model gateway with structured screening evidence and human review.
4. Implement a durable dispatch worker and sandbox telephony adapter. Recheck consent and policy at dispatch, then test revocation, failures and emergency-stop behavior.
5. Add calendar scheduling and candidate-verified offer acceptance.
6. Expand employee self-service and HR policies before implementing payroll or later HRMS phases.

Production integration choices and statutory payroll/telephony requirements require validation for the actual providers and deployment jurisdiction. This repository does not reproduce or validate prices from the planning document.

## Milestone A delivered

Job requirements, assignment-scoped manager/interviewer visibility, stage history, reasoned rejection, offer revision/expiry/maker-checker and filtered lists are implemented. Migrations 004 and 005 are forward-only additions; the enum snapshot includes assignments, employment types, event stages and rejection reasons. Existing job/application state machines remain human-controlled. Intake, consent/resume/retention changes (B), interviews/scorecards/reports (C), and all AI/queue/provider work remain outside this delivery. [Roadmap](talent-acquisition-plan.md).

## Milestone B delivered

Public published-job browsing and generic application intake are tenant-resolved without RLS bypass. Independent self-reported consent choices carry notice/IP/timestamp/user-agent evidence and do not replace staff-verified consent. Private PDF/DOCX uploads use local development storage or a signed S3-compatible adapter, with mandatory CLEAN scan status for audited API downloads. The malware/CAPTCHA ports are explicit stubs; there are no real scan/CAPTCHA provider calls. Admin erasure and a tenant-scoped retention CLI anonymize candidates, revoke consent, cancel planned calls and retry private document deletion while preserving evidence. See [operations](milestone-b-operations.md). Milestone C and all non-goals remain unimplemented.
