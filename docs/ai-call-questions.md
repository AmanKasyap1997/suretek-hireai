# AI call questions

With AI calling, an AI assistant phones shortlisted candidates who agreed to
be called and asks the job's questions. The recruiter then gets the answers
before interviews. This page covers preparing the questions; [AI calls](ai-calling.md)
covers placing the calls.

## Turn it on

An HR Admin opens **Integrations → AI providers → AI calling** and ticks
**Turn on AI calling and job call questions**.

- **On:** the job wizard shows call questions, and recruiters can call
  candidates once Plivo and a voice AI are set up.
- **Off:** the questions are hidden, but saved questions stay with each job.

Each change is recorded in the audit log.

## Prepare a job's questions

1. In the job wizard's **Screening Questions** step, HireAI drafts 6–8
   questions the first time you reach it: mostly technical questions on the
   job's key skills, plus at most two practical yes/no checks.
   - **Source:** the draft uses the job details, the description and the
     screening criteria.
   - **Provider:** **Draft with** picks the AI provider. It is shared with
     the job description's choice, and starts on the provider chosen for
     resume screening.
     - **One provider at a time:** only the picked provider is used. If it
       can't be used, for example when it has no credits, the message says
       why and suggests choosing another.
     - **Brief outages:** an "overloaded" or dropped-connection error is
       retried once automatically.
     - **No provider picked (API only):** each enabled provider is tried in
       turn, and if all fail, the error lists what went wrong with each.
2. Edit, remove or add questions (up to 10). **Regenerate with AI** drafts a
   new set, and **Restore previous questions** undoes that. Each question has:
   - **Answer:** a spoken answer (open or technical), yes or no, or a number.
   - **What a good answer covers** (spoken answers only): up to five key
     points, one per line. After the call, the screening AI rates the answer
     against them. The voice AI never sees them, so it can't hint.
   - **Flag if the answer isn't** (yes/no questions only): marks a
     deal-breaker. A different answer is flagged for the recruiter, never
     rejected automatically.
   - **Checks criterion:** links the question to a screening criterion, so
     its answer can settle a requirement the resume screening rated Unclear.
3. The **Publish Job** step lists the questions. Saving or publishing the job
   saves them. You can add or change questions after publishing too:
   **Edit** on the Jobs list ([editing a job](job-editing.md)).
4. Once the job is saved, **Try a test call** lets you answer the questions
   yourself, from the browser, as a candidate would.

## What the AI is told to ask

- **Mostly technical (at least four):** questions about concepts and how
  things work, the way an interviewer would ask on a phone screen.
  - **Examples:** for Laravel, "What does a service provider do in Laravel?"
    or "What is the service container, and why is it useful?".
  - **Answerable out loud:** each takes about a minute and needs no code.
  - **Key points:** each comes with 2–4 points a good answer covers.
- **No "Do you have experience with X?" or "How many years of X?":** those
  reveal little, and the resume already says it.
- **Practical checks (at most two):** yes/no questions for conditions the
  job states (shifts, travel, working on site) or availability, flagged when
  a different answer would be a deal-breaker.
- **One thing at a time,** in plain spoken English.
- **Nothing the apply form already asks:** notice period, pay, city,
  relocation, total experience, and current company and title.
- **Only about the job.** Never age, marriage, family, pregnancy, religion,
  caste, health, disability or nationality, and never ID numbers or bank
  details.

As a safety net, HireAI drops any drafted question that mentions those
personal topics. The recruiter still reviews every question, and questions
they write themselves are not filtered.

## Privacy

- **Drafting:** the AI sees only the job details, never any candidate's data.
- **Candidates:** the questions are staff-only, and never appear on the apply
  page or in the public jobs API.
- **Audit:** the trail records which provider and model drafted the
  questions and how many, but not the questions themselves.

## On a call

Calls go to candidates who applied under the apply page's notice, or gave
separate consent, and haven't opted out ([candidate applications](candidate-applications.md#contact-and-ai-calls)). After the call, the answers are rated against the key
points ([assessment](ai-calling.md#assessment)). Each call asks:

- the job's questions;
- up to two questions from that candidate's resume screening.

Each call keeps the questions it asked, so later edits don't change past
calls. See [AI calls](ai-calling.md).

## API

| Request                                        | Who                                              | Does                                             |
| ---------------------------------------------- | ------------------------------------------------ | ------------------------------------------------ |
| `GET /api/v1/jobs/call-questions/settings`     | HR Admin, Recruiter, Hiring Manager              | `{"enabled", "ai_available"}`                    |
| `POST /api/v1/jobs/call-questions`             | HR Admin, Recruiter, Hiring Manager              | Drafts questions from the job details; not saved |
| `PUT /api/v1/organization/ai-settings/calling` | HR Admin                                         | `{"enabled": true}` turns AI calling on          |
| `POST /api/v1/calls/test-sessions`             | HR Admin, Recruiter, Hiring Manager (their jobs) | Starts a browser test call with these questions  |

Jobs accept `callQuestions`: up to 10 objects with these fields:

- `id`;
- `text` (5–300 characters);
- `answer_type`: `yes_no`, `number` or `text`;
- `expected_answer`: `yes`, `no` or `null`, and only on `yes_no` questions;
- `criterion_id`, or `null`;
- `key_points`: up to 5 strings (2–200 characters), only on `text`
  questions. Defaults to `[]`.

## Deployment

Run migration `029_ai_call_questions.sql`. It adds the AI calling switch and
`jobs.call_questions`. Calls themselves need migrations 030 and 031 and the
setup in [AI calls](ai-calling.md).
