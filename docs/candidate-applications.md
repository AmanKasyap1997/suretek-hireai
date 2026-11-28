# Candidate applications

Candidates apply through HireAI. Applications, resumes and consent are stored
only in HireAI, so a careers website needs no database of its own.

## Contact and AI calls

The apply page has no separate contact checkboxes. Its privacy notice says
the organization may call the candidate about the application, including a
short screening call with an AI assistant. It also says the assistant says
it's an AI, that the call may be recorded and transcribed, and that the
candidate can decline or ask not to be called. Agreeing to the notice is
required to apply.

- **Recorded with the application:** calls, recording and transcription,
  with the notice version, IP address and a hash of the user agent as
  evidence. No confirmation email is sent.
- **Separate choices (API):** a form of your own may still send `consents`.
  Those choices are recorded as given, and a "Verify your contact
  preferences" email asks the candidate to confirm them. A "no" is
  respected: the candidate can't be called.
- **Opting out later:** staff record the candidate's withdrawal (consents
  API). Their latest choice always wins.
- **Notice version:** when the notice text changes, set a new
  `INTAKE_NOTICE_VERSION`, so each application records which notice the
  candidate agreed to.

## Ways to accept applications

1. **HireAI's apply page (no code).** Link to
   `https://{host}/console/careers/{organization}/jobs/{job id}`, or to
   `/console/careers/{organization}` for the list of open jobs. In the console,
   **Jobs → Copy apply link** copies a published job's link. Add
   `?source=linkedin`, `careers`, `referral`, `portal` or `social` to record
   where candidates came from.
2. **Your own form.** Read jobs from the public API and post applications to
   it straight from the candidate's browser (add your site's origin to
   `CORS_ORIGINS`). Don't forward applications through your server: HireAI
   limits applications per IP address, so every candidate would share one.

## Public API

No login. Every request is rate limited.

| Request                                                     | Returns                               |
| ----------------------------------------------------------- | ------------------------------------- |
| `GET /api/v1/public/{organization}/jobs?limit=&offset=`     | Published jobs, `total`, page details |
| `GET /api/v1/public/{organization}/jobs/{id}`               | One published job, with page details  |
| `POST /api/v1/public/{organization}/jobs/{id}/applications` | `202 {"message": "…received."}`       |

Page details: `organization.name`, `noticeVersion` (send it back when
applying), `resumeMaxBytes`, and `captcha` (`null`, or the Turnstile
`siteKey` and `action` to render).

### Applying

Send `multipart/form-data` with two parts:

- `application`: the form fields below, as a JSON string.
- `resume`: the file, PDF or DOCX, up to `resumeMaxBytes` (5 MB by default).

A JSON body with the resume inline as
`"resume": {"filename": "cv.pdf", "base64": "…"}` also works, for resumes up
to 512 KB.

| Field                   | Required | Notes                                                                                                                                 |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `fullName`              | Yes      | 2–200 characters                                                                                                                      |
| `email`                 | Yes      |                                                                                                                                       |
| `phone`                 | Yes      | With country code, no spaces: `+919876543210`                                                                                         |
| `currentLocation`       | Yes      | City, 2–120 characters                                                                                                                |
| `totalExperienceMonths` | Yes      | Whole months, 0–720 (0 for a fresher)                                                                                                 |
| `noticePeriod`          | Yes      | `IMMEDIATE`, `DAYS_15`, `DAYS_30`, `DAYS_45`, `DAYS_60`, `DAYS_90`, `OVER_90_DAYS`, `SERVING_NOTICE`                                  |
| `expectedCtc`           | Yes      | Annual, more than 0                                                                                                                   |
| `privacyAccepted`       | Yes      | Must be `true`                                                                                                                        |
| `noticeVersion`         | Yes      | From the job response                                                                                                                 |
| `ctcCurrency`           | No       | ISO code, default `INR`                                                                                                               |
| `currentCtc`            | No       | Annual                                                                                                                                |
| `currentTitle`          | No       | Up to 200 characters                                                                                                                  |
| `currentCompany`        | No       | Up to 200 characters                                                                                                                  |
| `lastWorkingDay`        | No       | `YYYY-MM-DD`, only with `SERVING_NOTICE`                                                                                              |
| `willingToRelocate`     | No       | `true` or `false`                                                                                                                     |
| `linkedinUrl`           | No       | A linkedin.com address                                                                                                                |
| `portfolioUrl`          | No       | Any web address                                                                                                                       |
| `coverLetter`           | No       | Up to 4,000 characters                                                                                                                |
| `source`                | No       | `CAREERS_SITE`, `LINKEDIN`, `REFERRAL`, `JOB_PORTAL`, `SOCIAL`, `OTHER`; default `DIRECT`                                             |
| `referrer`              | No       | Who referred them, only with `REFERRAL`                                                                                               |
| `consents`              | No       | Separate contact choices, `{"CALL": bool, "RECORDING": bool, "TRANSCRIPTION": bool}`. Omitted: the privacy notice applies (see below) |
| `captchaToken`          | When on  | The Turnstile token, when `captcha` isn't `null`                                                                                      |
| `website`               | No       | Spam trap: render it hidden and leave it empty                                                                                        |

Empty optional text counts as not given.

### Responses

| Status | Meaning                                                                                                           |
| ------ | ----------------------------------------------------------------------------------------------------------------- |
| `202`  | Received. The same reply is sent when this email already applied.                                                 |
| `400`  | `errors: [{path, message}]` names each problem field; or the resume is invalid, or `noticeVersion` is out of date |
| `403`  | The CAPTCHA check failed                                                                                          |
| `404`  | Unknown organization, or the job isn't published                                                                  |
| `413`  | The resume is too large                                                                                           |
| `429`  | Too many applications from this IP address or email; try again later                                              |

### Applying twice

An email address can apply to a job once. A second application is not saved
and changes nothing, but gets the same `202` reply as a new one, so the form
never reveals whether someone applied (to their current employer, for
example). Instead, the address on file gets an email saying they've already
applied and their first application is unchanged, at most once a day per
application. HireAI's apply page also remembers, in that browser, which jobs
it applied to, and shows "You've already applied" instead of the form.

A new application from a known email keeps the candidate's existing name and
phone, and stores this application's answers and resume with the
application. Each application keeps the resume sent with it. A later
application never replaces the resume on an earlier one, because the form
only needs an email address.

## In HireAI

**Applications** lists everyone who applied. **View** shows what they sent:
HR admins, recruiters and hiring managers see contact details and pay;
interviewers don't. HR admins and recruiters can download the resume after
the virus scan passes. Erasing a candidate deletes these answers too.

New applications are screened with AI when the organization has an AI
provider enabled: each resume is rated against the job's screening criteria
and given a match score. Recruiters then shortlist or reject from the same
view. See [Resume screening](resume-screening.md).

## Deployment

- Run migrations `024_application_details.sql`,
  `025_application_repeat_notices.sql`, `026_resume_screening.sql`,
  `027_application_resumes.sql`, `028_organization_ai_settings.sql` and
  `029_ai_call_questions.sql`.
- The "already applied" email uses the SMTP adapter; with `EMAIL_ADAPTER=log`
  it is only noted in the API log.
- The Caddy config allows request bodies up to 6 MB for resume uploads only.
  If you raise `RESUME_MAX_BYTES`, raise that limit too.
- To turn on the CAPTCHA, set `CAPTCHA_PROVIDER=turnstile`,
  `TURNSTILE_SECRET_KEY` and `TURNSTILE_SITE_KEY`. Caddy already allows the
  Turnstile script on `/console/careers` pages.
