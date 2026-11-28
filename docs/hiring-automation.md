# Automatic hiring steps

HireAI can move strong candidates forward by itself, from application to a
booked interview:

1. **Shortlist:** an applicant whose resume screening scores at least the
   organization's score (70 by default) is shortlisted.
2. **Screening call:** they're called with the AI screening call.
3. **Interviews:** a candidate whose call scores at least the organization's
   score moves to **In Interview**.
4. **Booking call:** the AI calls them again with the news that they're
   shortlisted for the interview, offers two or three times the panel is
   free, and books the one they pick. The calendar sends the invitations,
   with a Google Meet or Teams link.

Each step is optional. Candidates only ever move forward: nobody is rejected
automatically. Anyone below a score waits for a recruiter, who can still move
them on, reject them, or call them.

## Set up

1. **Server:** run migrations `035_hiring_automation.sql`
   and `036_work_recovery.sql` (`npm run db:migrate`), then restart the
   backend. With both Google and Microsoft calendars connected, bookings go
   in the one chosen in Integrations (migration `037_interview_calendar.sql`,
   [interviews](interviews.md)).
2. **Calendar (for booking):** an HR Admin connects Google Calendar or
   Microsoft Calendar in **Integrations → Calendars**.
   - **Google:** the platform's Google application needs the
     `calendar.freebusy` scope ([Google Calendar](google-calendar-oauth.md)).
     A calendar connected before it was added must be authorized again.
   - **Free/busy for the panel:** the connected account must be able to see
     the panel's free/busy times, as colleagues in the same Google Workspace
     or Microsoft 365 organization usually can. When a panel member's
     calendar can't be read, only their HireAI interviews are avoided.
3. **Steps:** in **Integrations → AI hiring tools**, an HR Admin turns on
   the steps and sets their scores, then **Save automatic steps**:
   - **Resume screening** card: shortlist at a resume score, and call them
     with the AI screening call;
   - **AI calling** card (with AI calling on): move to interviews at a call
     score, and call them to book one.
4. **Each job's interview booking:** in **Jobs**, a recruiter opens
   **Interview booking** on the job and sets:
   - the round (e.g. "Final round"), length (30–90 minutes) and type (video,
     phone or onsite, with its location);
   - the panel: HR Admins, recruiters, hiring managers or interviewers;
   - the days and hours to offer, in the calling time zone
     (`CALL_TIMEZONE`).

   It can be changed until the job closes.

## What happens, and when not

| Step               | Happens when                                                                                | Doesn't happen when                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Shortlist          | A resume screening completes at or above the score and the application is still **Applied** | A must-have requirement is clearly missing, or the score is lower                             |
| Screening call     | The candidate was just shortlisted automatically and AI calling is on                       | The candidate hasn't agreed to be called, the job has no call questions, or a call is planned |
| Move to interviews | A screening call's assessment is at or above the score and the candidate is **Shortlisted** | A yes/no deal-breaker answer was wrong, or the score is lower                                 |
| Booking call       | The candidate just moved to interviews and the job has its interview booking set up         | No interview booking on the job (the reason is kept in the audit log)                         |

When a call isn't planned, the reason goes in the audit log
(`call.auto_not_planned`).

**Restarts don't stop the steps.** Calls are queued in the database. Resume
screenings and call assessments run in the API's memory, so after a restart
the API picks up the ones left behind (within about 10 minutes), and the next
step follows as usual.

## The booking call

- **Before dialing:** HireAI finds up to three free times in the next two
  weeks, from tomorrow: the earliest free time on each of the first days that
  have one. A time is free when the connected calendar, every panel member's
  calendar, and their HireAI interviews are all free.
- **No call without times:** with no calendar, no interview booking on the
  job, or no free time, the call isn't placed. The application's Call Summary
  says why.
- **On the call:** the AI checks who answered, says it's an AI assistant,
  shares the news, and offers the times. When the candidate picks one, it
  says it back to confirm and books it. If the time was taken meanwhile, it
  offers the others. If none suit them, it notes their preferred times for
  the recruiting team.
- **The booking:** an event in the connected calendar, inviting the panel and
  the candidate (the calendar emails them), and the interview in HireAI with
  its meeting link. It appears in the candidate's History and the Call
  Summary.
- **Cancelling:** cancelling the interview in HireAI also cancels the
  calendar invitation.
- **Rescheduling** in HireAI moves the calendar event, and everyone invited
  is told ([interviews](interviews.md)).

## Records

- **Stage history:** automatic moves are recorded with a note, such as
  "Automatic: resume score 82 (shortlisted at 70 or more)", and no person.
- **Audit log:** `application.auto_shortlisted`, `application.auto_interview`,
  `interview.booked_by_call`, `call.auto_not_planned`, and
  `organization.ai_automation_updated` for the settings.
- **Calls:** a call HireAI placed by itself shows "asked automatically".
