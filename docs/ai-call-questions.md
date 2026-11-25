# AI call questions

When AI calling is available, an AI assistant will call each candidate who
agreed to be called and ask the job's questions. The recruiter then gets the
answers before interviews. **Calls aren't placed yet:** HireAI has no phone or
voice provider. What works today is preparing each job's questions, so they're
ready when calling arrives.

## Turn it on

An HR Admin opens **Integrations → AI providers → AI calling** and ticks
**Turn on AI calling and job call questions**.

- **On:** the job wizard shows call questions.
- **Off:** the questions are hidden, but saved questions stay with each job.

Each change is recorded in the audit log.

## Prepare a job's questions

1. In the job wizard's **Screening Questions** step, HireAI drafts 5–8
   questions the first time you reach it.
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
   - **Answer:** yes or no, a number, or a free answer.
   - **Flag if the answer isn't** (yes/no questions only): marks a
     deal-breaker. A different answer is flagged for the recruiter, never
     rejected automatically.
   - **Checks criterion:** links the question to a screening criterion, so
     its answer can settle a requirement the resume screening rated Unclear.
3. The **Publish Job** step lists the questions. Saving or publishing the job
   saves them.

## What the AI is told to ask

- **One thing at a time:** each question is short, in plain spoken English,
  and can be answered in under a minute.
- **What a resume shows poorly:** hands-on depth with the key requirements,
  willingness for stated conditions (shifts, travel, working on site), and
  availability to interview.
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

## When calling is built

Calls will only go to candidates whose call consent was given on the apply
form and verified by email. That consent check already exists.

Each call will ask:

- the job's questions;
- two or three questions from that candidate's resume screening.

Each call will keep the questions it asked, so later edits don't change past
calls.

## API

| Request                                        | Who                 | Does                                             |
| ---------------------------------------------- | ------------------- | ------------------------------------------------ |
| `GET /api/v1/jobs/call-questions/settings`     | HR Admin, Recruiter | `{"enabled", "ai_available"}`                    |
| `POST /api/v1/jobs/call-questions`             | HR Admin, Recruiter | Drafts questions from the job details; not saved |
| `PUT /api/v1/organization/ai-settings/calling` | HR Admin            | `{"enabled": true}` turns AI calling on          |

Jobs accept `callQuestions`: up to 10 objects with these fields:

- `id`;
- `text` (5–300 characters);
- `answer_type`: `yes_no`, `number` or `text`;
- `expected_answer`: `yes`, `no` or `null`, and only on `yes_no` questions;
- `criterion_id`, or `null`.

## Deployment

Run migration `029_ai_call_questions.sql`. It adds the AI calling switch and
`jobs.call_questions`.
