# Candidates page

The Candidates page is where recruiters and HR Admins manage candidates once
they're shortlisted: interviews, AI calls, and moving them on or rejecting
them. New applications and their AI screening stay on the Applications page.

## What it lists

Every application from **Shortlisted** onward, across jobs:

| Tab            | Shows                                     |
| -------------- | ----------------------------------------- |
| All Candidates | Shortlisted, In Interview, Offered, Hired |
| Shortlisted    | Shortlisted for the job                   |
| In Interview   | Moved to interviews                       |
| Offered        | With an offer (set by the offers process) |
| Hired          | Hired (set by the offers process)         |

- **Counts:** each tab shows how many candidates match the search and filters.
- **Filters:** search by name or email, the job, the AI result (Strong, Good,
  Partial or Weak match, or Not screened), and under **More Filters** the
  date applied and the order (newest, or best AI score first).
- **Pages:** 10 candidates a page.

Rejected candidates don't appear; their history stays on the application.

## AI call column

Each candidate's **AI Call** column shows whether the AI screening call was
completed, and its score:

| Shows                                                | Means                                                                             |
| ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| ✓ Completed and a score                              | A call got through the questions; the score is the AI's assessment of the answers |
| ✓ Completed, Scoring…                                | The answers are still being assessed                                              |
| Call back, and a time                                | The candidate asked to be called later; the AI calls at the time agreed           |
| Scheduled / Calling…                                 | A call is waiting for calling hours, or on the line                               |
| Declined, Wrong number, Unreached, Failed, Cancelled | The latest call didn't get through the questions: not completed                   |
| Not called                                           | No AI call yet                                                                    |

The list refreshes by itself while calls are in progress.

## Interviews wait for a completed call

While AI calling is on for the organization, **Schedule Interview** and
**Move to In Interview** are available only for candidates who completed an AI
call. For others they're greyed out with the reason, and the panel offers
**Call now**, which opens Call Summary. **Bulk Actions → Move to In
Interview** moves only the candidates with a completed call and says how many
stayed shortlisted.

With AI calling off, interviews don't wait for a call.

This is a Candidates page rule: the Applications page's **Move to Interview**
doesn't check for a call.

## The candidate panel

Selecting a candidate opens their panel:

- **Overview:**
  - **Key Information:** what they told you on the apply form (experience,
    current role, current and expected pay, notice period, relocation).
  - **Skills (Extracted):** skills the AI found in the resume while screening
    it. Screenings from before this feature have none: screen again to see
    them.
  - **AI Insights:** the screening's match, strengths and concerns. They're
    suggestions: the recruiter decides.
- **Resume:** download the resume sent with the application, plus the cover
  letter and links.
- **AI Screening:** the full screening, and **Screen again**.
- **Call Summary:** AI calls, their answers and assessment, and **Call with
  AI** ([AI calls](ai-calling.md)).
- **Interviews:** each interview's time, type, link or location, panel,
  whether it's in the calendar and its feedback; open one to reschedule,
  cancel or add it to the calendar ([interviews](interviews.md)).
- **History:** every stage change, with rejection reasons.

## Actions

| Action             | Where                        | What happens                                                                                                                                                                                     |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Schedule Interview | Panel, or a row's **…** menu | Choose the round, type (video, phone or onsite), date, time, length and panel; with a calendar connected, it invites the panel and the candidate. A shortlisted candidate moves to In Interview. |
| Move to Stage      | Panel, or a row's **…** menu | Shortlisted → In Interview, or reject (with a reason). Offered and Hired are set by the offers process.                                                                                          |
| Add Candidate      | Page header                  | Adds someone sourced or referred to a job's shortlist, with an optional resume, which the AI then screens. An existing candidate with the same email is reused.                                  |
| Bulk Actions       | Tick candidates first        | Move to In Interview, Call with AI (without recording or transcript), or Reject with one reason.                                                                                                 |

- **Interview panel:** any active HR Admin, recruiter, hiring manager or
  interviewer in the organization. A panellist can't have two interviews at
  the same time.
- **Who can use the page:** HR Admins and recruiters.

## API

The page uses the existing endpoints, with these additions:

- `GET /applications?stages=SHORTLISTED,INTERVIEW,OFFER,HIRED`: any of these
  stages.
- `GET /applications?fit=STRONG`: completed screenings with this fit.
- `GET /applications?counts=true`: adds `stage_counts`, the matches per stage
  whatever stage is shown.
- List rows include `candidate_email` (for roles that see contact details) and
  `current_title`.
- List rows include the AI call, for HR Admins and recruiters: `call_status`
  and `call_outcome` (the latest call), `call_completed` (any call got through
  the questions), and that call's `call_assessment_status`, `call_score` and
  `call_fit`.
- `GET /interviews/panelists`: who can sit on an interview panel.
