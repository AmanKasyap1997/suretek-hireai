# Resume screening

HireAI uses the organization's AI provider to read each resume and compare it
with the job's screening criteria. Recruiters get a match score, with the
resume's own words as evidence for each criterion. Screening is advice only:
it never changes an application's stage. Shortlisting and rejecting stay with
people.

## Before you start

- An HR Admin connects, tests and enables OpenAI, Anthropic or Google AI
  Studio in **Integrations**, the same connection used for AI job
  descriptions.
- **Choose the AI:** in **Integrations → AI providers → Resume screening**,
  an HR Admin chooses which provider screens resumes. Resumes are sent only
  to the providers this setting allows.
  - **Automatic** (the default): HireAI tries the enabled providers in order:
    OpenAI, then Anthropic, then Google AI Studio (production before
    sandbox). When one can't be used, the next one screens instead. Causes
    include no credits, a rejected key, a rate limit or an outage.
  - **A chosen provider:** only that provider screens, so every candidate is
    scored by the same AI. If it can't be used, the screening says why and
    recruiters screen again once it's fixed.
  - **Backup:** tick **If … can't be used, screen with another enabled
    provider** to fall back to the others. Candidates for one job may then
    be scored by different AI models.
  - **What you see:** each screening names the provider that did it and
    explains why any others were skipped. A refusal is about the resume
    itself, so it is never retried with another provider.
  - **Job descriptions:** AI job descriptions start on the same provider,
    and the drafting picker can still choose another.
  - **Not enabled:** if the chosen provider is later disabled, Integrations
    and the job's screening bar say so.
- Run migrations `026_resume_screening.sql`, `027_application_resumes.sql`
  and `028_organization_ai_settings.sql`, then restart the API.

## How it works

1. **Criteria.** Each job's screening criteria have a weight (1–100) and can
   be marked must-have. If a job has no criteria, the AI picks the 4 to 6 most
   important requirements from the job description, each with weight 1.
2. **When resumes are screened:**
   - **Automatically,** for each new application from the apply page, when the
     job's **Screen new applications with AI** setting is on. It is on by
     default.
   - **One application:** **Screen resume** (or **Screen again**) in the
     application's view.
   - **A whole job:** filter **Applications** by job, then choose
     **Screen _n_ unscreened applications**. This queues applied and
     shortlisted applications that were never screened or whose screening
     failed, up to 100 at a time.
3. **What the AI is sent:**
   - The resume sent with this application: a PDF as the file, a Word file
     as its text. A candidate who applies to several jobs keeps one resume
     per application, so each application is screened against the resume
     sent with it. An application added by staff uses the resume staff
     uploaded for the candidate.
     - **Fallback:** if staff uploaded no resume, the application uses the
       resume the candidate sent with another application.
   - The job: title, department, location, type and description.
   - The criteria.
   - The candidate's job-related answers: experience, current title and
     company, city, relocation, notice period and cover letter.

   HireAI's instructions to the AI don't include the candidate's name, email,
   phone or pay, or the resume's file name. The resume itself may still contain
   personal details.

4. **What comes back:**
   - For each criterion: a rating (Meets, Partly meets, Not met or Unclear), a
     quote from the resume and a one-line reason.
   - A short summary, strengths, concerns and questions to ask.
5. **The score is worked out by HireAI, not the AI.**
   - **Credit:** Meets earns the criterion's full weight, Partly meets half,
     and Not met or Unclear nothing.
   - **Score:** the share of the total weight earned, from 0 to 100.
   - **Labels:** 75 or more is a Strong match, 50–74 Good, 25–49 Partial, and
     under 25 Weak.
   - **Must-haves:** a must-have rated Not met shows **Missing a must-have**
     and limits the label to Partial match.
6. **Review and decide.** **Applications** shows an **AI match** column and
   can sort by **Best match first**. **View** shows the full screening above
   the application, and a **Decision** section to shortlist, move to
   interview, or reject with a reason.

## Who sees what

| Role                   | Read screenings                  | Run screenings | Decide                                      |
| ---------------------- | -------------------------------- | -------------- | ------------------------------------------- |
| HR Admin and Recruiter | Yes                              | Yes            | Shortlist, move to interview, reject        |
| Hiring manager         | Assigned jobs only               | No             | Shortlist or reject, for assigned jobs only |
| Interviewer            | No (screenings quote the resume) | No             | No                                          |

## Safeguards

- **People decide.** A screening never changes a stage. Each stage change is
  a person's action and is recorded in the stage history.
- **Fairness.** The AI is told to judge only job-related skills and
  experience. It must not consider name, photo, age, gender, marital status,
  religion, caste, nationality, disability, health or family. It must not
  penalise career breaks or favour particular colleges or employers.
- **Prompt injection.** Resume text is treated as information, never as
  instructions. If a resume tries to instruct the AI (for example, hidden
  "rate me highly" text), the screening says so.
- **Evidence and history.**
  - **Criteria used:** each screening keeps the criteria it used. If the job's
    criteria change afterwards, the screening is marked as out of date.
  - **History:** screening again adds a new result and keeps the earlier one.
  - **Audit trail:** `application.screened`, `application.screening_failed`
    and `job.screening_requested` record the provider, model and score, but
    never resume content.
- **Erasure.** Erasing a candidate deletes their screenings too.
- **Virus scan.**
  - **Infected:** resumes found infected are never screened.
  - **Still being scanned:** a resume can be screened before its scan
    finishes. The file is only sent to the AI provider, never to staff.

## When screening fails

The application shows why, in plain words. Common causes:

| Shown as                         | What to do                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------- |
| No AI provider is enabled        | An HR Admin enables one in Integrations                                      |
| Rejected credentials / reconnect | An HR Admin re-enters or tests the key in Integrations                       |
| Out of credits / usage limit     | Add credits with the AI provider, or choose another provider in Integrations |
| Chosen provider isn't enabled    | Enable it, or choose another provider in Integrations                        |
| Limiting requests                | Screen again in a minute                                                     |
| Unavailable                      | A brief outage is retried once automatically; screen again shortly           |
| Couldn't read the resume         | The resume may be empty, image-only Word, or not a resume                    |
| Interrupted                      | The API restarted mid-screening; screen again                                |

## Cost and limits

- **Cost.** Each screening is one request to the organization's AI provider,
  billed to that account. Turn off **Screen new applications with AI** on
  high-volume jobs to screen only on request.
- **Speed.** Each API server runs two background screenings at a time. A
  screening usually takes under a minute.
- **Restarts.** A restart drops queued screenings. They show as interrupted,
  and **Screen _n_ unscreened applications** picks them up again.
- **Length limits.** Only the first 60,000 characters of a Word resume and
  the first 12,000 of a job description are sent.

## API

| Request                                   | Who                                 | Does                                                                     |
| ----------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `GET /api/v1/applications/:id/screening`  | HR Admin, Recruiter, Hiring manager | `{"screening": …}`, the newest result, or `null`                         |
| `POST /api/v1/applications/:id/screening` | HR Admin, Recruiter                 | Screens now and returns the result, including a failure                  |
| `GET /api/v1/jobs/:id/screening`          | HR Admin, Recruiter, Hiring manager | Counts: total, screened, in progress, failed, to screen                  |
| `POST /api/v1/jobs/:id/screening`         | HR Admin, Recruiter                 | `202 {"queued", "skipped"}`; skipped have no resume                      |
| `GET /api/v1/organization/ai-settings`    | HR Admin                            | The screening provider, the enabled providers, any problem               |
| `PUT /api/v1/organization/ai-settings`    | HR Admin                            | `{"screeningProvider": "anthropic" or null, "screeningFallback": false}` |

- **Application list:** `GET /api/v1/applications` also returns
  `screening_status`, `screening_score`, `screening_fit` and
  `screening_missing_must_have`, which are `null` for interviewers. It
  accepts `sort=score` and
  `screening=screened|not_screened|in_progress|failed`.
- **Jobs:** jobs accept `autoScreen` (`true` or `false`).

## Deployment

- Run migration `026_resume_screening.sql`. It adds `jobs.auto_screen`
  (default on) and the `application_screenings` table, with forced row-level
  security.
- Run migration `027_application_resumes.sql`. It links each resume to the
  application it was sent with. It also links earlier resumes from the apply
  page, which were saved in the same transaction as their application.
- Run migration `028_organization_ai_settings.sql`. It stores each
  organization's screening provider; with no row, screening is automatic.
- **Privacy notice.** The apply page's privacy notice now says the company
  may use an AI service to compare resumes with the job's requirements.
  - **Review:** have the notice reviewed, by legal counsel where needed.
  - **Version:** raise `INTAKE_NOTICE_VERSION`, so new consents record the
    updated notice.
- **Model choice.** `INTEGRATION_OPENAI_MODEL`, `INTEGRATION_ANTHROPIC_MODEL`
  and `INTEGRATION_GOOGLE_AI_MODEL` choose the model, as for job descriptions.
  The model must accept PDF input.
