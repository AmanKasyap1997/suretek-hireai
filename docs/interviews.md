# Interviews

Recruiters schedule interviews from the Candidates page, or the AI books them
on a call ([automatic hiring steps](hiring-automation.md)). Every interview is
then in three places:

- **HireAI's Interviews page:** a month calendar and a list, for the whole
  organization. Hiring managers and interviewers see the interviews they're
  on.
- **The application:** the Interviews tab on the Candidates page, and the
  Interviews section of an application on the Applications page.
- **Calendars:** with Google Calendar or Microsoft Calendar connected, an
  event in the connected account's calendar that invites the panel and the
  candidate. The invitation puts it in their own calendars too, and the
  calendar emails them about every change.

## Set up the calendar

An HR Admin connects Google Calendar or Microsoft Calendar in **Integrations →
Calendars** ([Google Calendar](google-calendar-oauth.md)). The connected
account organizes every interview event: use a shared recruiting account
rather than a personal one.

Without a calendar, interviews are only in HireAI and nobody is sent an
invitation. The Interviews page says so.

**Both connected:** interviews go in Google Calendar until an HR Admin
chooses **Interviews go in: Microsoft Calendar** at the top of **Integrations →
Calendars** (run migration `037_interview_calendar.sql` first). The AI's
interview booking uses the same calendar. Recruiters can still pick the other
one when scheduling, and move an interview from one to the other.

## Schedule an interview

On the Candidates page, choose **Schedule Interview** for a shortlisted or
interviewing candidate (after a completed AI call, while AI calling is on):

| Field         | What it does                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Round         | Its name, e.g. "Round 1" or "Technical round".                                                                                      |
| Type          | Video call, phone or onsite.                                                                                                        |
| Date and time | In your time zone. Everyone sees it in theirs.                                                                                      |
| Meeting link  | Video only: **Create a Google Meet link** (or Teams link) with the calendar, or use your own.                                       |
| Location      | Onsite only.                                                                                                                        |
| Panel         | Active HR Admins, recruiters, hiring managers and interviewers. Nobody can be in two at once.                                       |
| Calendar      | **Add to Google Calendar and invite the panel and the candidate**, ticked when one is connected. With both connected, choose which. |

A shortlisted candidate moves to In Interview.

**Who was invited:** after saving, HireAI says which calendar sent the
invitations, from which account, and to which candidate address, e.g.
"Microsoft Calendar sent invitations from hr@yourcompany.com to
rahul@example.com and 2 panel members." Check the address if the candidate
says nothing arrived (and their spam folder).

**No email when the candidate is the calendar itself:** Google and Microsoft
don't email an event's organizer. If the candidate's address is the connected
calendar's own account (common when testing with your own email), the event
appears in that calendar but no invitation email is sent, and HireAI warns
you. Test with a different address, and connect a shared recruiting account.

**The event:** titled "Round 1: Candidate · Job", with the round, job,
organization, type, link or location and panel's names. The candidate is
invited, so everyone invited sees the others' email addresses, as with any
calendar invitation.

## Change or cancel it

Open the interview from the Interviews page or the application:

- **Reschedule:** change the round, type, time, length, link, location or
  panel. The calendar event changes too, and everyone invited is told. An
  interview not in the calendar yet can be added while rescheduling.
- **Cancel interview:** with a reason, kept in the audit log. The calendar
  event is removed, and everyone invited is told.
- **Add to calendar:** for an interview scheduled without invitations, or when
  the calendar refused (see below). **Send the invitation again** updates the
  event if it was changed or deleted in the calendar.
- **Move to Microsoft Calendar** (or Google): with both connected. The new
  calendar sends fresh invitations and the old event is cancelled, so
  everyone gets a cancellation and a new invitation. A Meet or Teams link the
  old calendar created is replaced; your own link is kept.

## Feedback

Once the interview has started, each panelist chooses **Give feedback**:

- **Scores:** 0 to 5 for each of the job's screening criteria (as they were
  when the interview was scheduled).
- **Recommendation:** strong hire, hire, hold, no hire or strong no hire.
- **Notes:** for the hiring decision.

Feedback can't be changed once submitted. Panelists see only their own;
HR Admins and recruiters see everyone's, with each person's average score.
Feedback never changes the candidate's stage.

## When the calendar has a problem

The interview is always saved in HireAI. If the calendar refuses, the
recruiter is told why and the interview shows **Not in a calendar**:

| Problem                     | What to do                                                           |
| --------------------------- | -------------------------------------------------------------------- |
| Needs to be connected again | An HR Admin reconnects it in Integrations, then **Add to calendar**. |
| Didn't allow adding events  | Reconnect it, allowing calendar access.                              |
| Couldn't be reached         | **Add to calendar** again shortly.                                   |

A video interview whose link was to come from the calendar has no link until
it's added. Microsoft accounts without Teams (personal Outlook accounts) can't
create a Teams link: the invitation is still sent, without a link, and HireAI
says so; add your own link by rescheduling. The server log records the
provider and HTTP status, never the event's contents.

## API

| Request                           | Who                                          | What                                                                                                                          |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `GET /interviews`                 | HR Admin, recruiter; others for their panels | Filters: `applicationId`, `jobId`, `status`, `when` (`upcoming`, `past`), `from`/`to` (overlapping).                          |
| `GET /interviews/:id`             | Same                                         | With the candidate, job, panel names, feedback count and `on_calendar`.                                                       |
| `GET /interviews/calendar`        | HR Admin, recruiter                          | `{"provider","connected"}`: where interviews go (or null), and every connected calendar.                                      |
| `PUT /interviews/calendar`        | HR Admin                                     | `{"provider"}`: where interviews go when both are connected.                                                                  |
| `POST /interviews`                | HR Admin, recruiter                          | `sendInvitations: true` adds it to the calendar (`calendarProvider` picks one); a video interview may then omit `meetingUrl`. |
| `PATCH /interviews/:id`           | HR Admin, recruiter                          | Also `round`, and `sendInvitations` or `calendarProvider` to add it to (or move it to) a calendar.                            |
| `POST /interviews/:id/calendar`   | HR Admin, recruiter                          | Adds it to a calendar, sends its event again, or with `{"calendarProvider"}` moves it.                                        |
| `POST /interviews/:id/cancel`     | HR Admin, recruiter                          | `{"reason"}`. Removes the calendar event.                                                                                     |
| `POST /interviews/:id/scorecards` | The interview's panelists                    | `{"scores":[{"criterionId","score"}],"recommendation","notes"}`.                                                              |

Scheduling, rescheduling and adding to the calendar return the interview with
`calendar`: `{"status":"added"|"updated"|"moved"|"not_sent"|"not_connected"|"failed","provider","problem"}`,
and once in a calendar `organizer` (the account invitations come from),
`candidate` (the address invited), `panel` (how many panelists) and
`warnings` (`candidate_is_organizer`, `no_meeting_link`).
