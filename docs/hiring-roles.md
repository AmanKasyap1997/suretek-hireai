# Hiring roles: HR Admin, Recruiter, Hiring Manager

## How a job gets published

1. **The hiring manager requests it.** Jobs → **Request a Job**: title,
   department, location, openings, salary range, description (AI can draft
   it), required skills and, with AI calling on, the AI call questions
   (drafted by AI, and tried with **Try a test call**). They save it as a
   draft, then **Submit for Approval**. They're put on the job's hiring team
   automatically.
2. **An HR Admin approves it**, or sends it back. Requests show as **Awaiting
   approval** on the Jobs list, with who asked, and the HR Admin's dashboard
   says how many are waiting (**Awaiting approval** in the status filter lists
   them). **Send back** asks for changes with a note; the hiring manager sees
   it, changes the request and submits it again.
3. **A recruiter publishes it.** Approved jobs show **Ready to publish**, and
   the dashboard says how many. The recruiter can refine the screening
   criteria and AI call questions (**Edit**), then **Publish**, choosing the
   channels: the careers website, LinkedIn, or only in HireAI.

Recruiters don't create jobs, and can't edit or set up a job (interview
booking included) until an HR Admin approves it: before that they see it as
**Awaiting approval**, view only. An HR Admin can do every step, including
creating and publishing a job in one go.

Once approved, a hiring manager can't change the job, and only an HR Admin
changes what candidates see ([editing a job](job-editing.md)). Run migration
`038_job_requests.sql` for job requests.

## What each role does

| Area                      | HR Admin                                     | Recruiter                                           | Hiring Manager                                                          |
| ------------------------- | -------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------- |
| Home                      | Dashboard, with requests to approve          | Dashboard, with jobs to publish                     | Their jobs and requests, applicants to review, interviews, feedback due |
| Jobs                      | Create, approve or send back, publish, close | Once approved: edit, publish to the channels, close | Request jobs; edit their requests until approved                        |
| Hiring team (Jobs)        | Add and remove people                        | See who's on it                                     | –                                                                       |
| Applications              | All                                          | All                                                 | Their jobs' applicants: resume, AI screening, contact                   |
| Stage decisions           | All                                          | All                                                 | Shortlist or reject                                                     |
| Candidates page, AI calls | Yes                                          | Yes                                                 | –                                                                       |
| Interviews                | All; schedule, reschedule, cancel            | Same                                                | The ones they're on; give feedback                                      |
| Integrations, Team        | Yes                                          | –                                                   | –                                                                       |

**A hiring manager sees the jobs they requested, and jobs an HR Admin adds
them to** (Jobs → **Hiring team**). Interviewers see jobs they're added to,
and interviews they're on.

Deleting a job's LinkedIn post stays with HR Admins.

## Try it

1. **Invite them.** As the HR Admin, open **Team & invitations** and invite a
   Recruiter and a Hiring Manager. Each gets an email to set a password (with
   `EMAIL_ADAPTER=log`, the link is in the backend's log instead).
   - **One inbox:** Gmail delivers `you+recruiter@gmail.com` and
     `you+manager@gmail.com` to `you@gmail.com`, and HireAI treats them as two
     accounts.
2. **Sign in as each** in a separate browser profile or a private window (a
   window holds one sign-in).
3. **Hiring manager:** **Request a Job**, fill it in and **Submit for
   Approval**.
4. **HR Admin:** on the dashboard, open the request; **Send back** with a
   note, or **Approve**.
5. **Hiring manager** (if sent back): read the note, change the request and
   submit it again.
6. **Recruiter:** open the approved job, check or refine its call questions,
   and **Publish** it, choosing the channels.
7. **Apply** from the careers page, then follow the candidate:
   - **Hiring manager:** open the applicant from their home page, read the
     resume and AI screening, and **Shortlist** or **Reject**.
   - **Recruiter:** on **Candidates**, call them with AI (if AI calling is
     on), then **Schedule Interview** with the hiring manager on the panel.
   - **Hiring manager:** on **Interviews**, open the interview once it has
     started and **Give feedback**. Recruiters and HR Admins see it; other
     panelists don't.
