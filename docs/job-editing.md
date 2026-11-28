# Editing a job

A job can be edited until it's closed: as a draft, once approved, and once
published. On the Jobs list, choose **Edit**, change what you need in any
step, and choose **Save Changes** on an approved or published job (**Save
Draft** on a draft).

## Who can change what

| What                                                                                             | Draft                    | Approved or published  |
| ------------------------------------------------------------------------------------------------ | ------------------------ | ---------------------- |
| What candidates see: title, department, location, employment type, openings, salary, description | HR Admin, hiring manager | HR Admin               |
| Required skills, screening criteria, AI screening, AI call questions                             | HR Admin, hiring manager | HR Admin and recruiter |
| Interview booking (**Interview booking** on the Jobs list)                                       | HR Admin                 | HR Admin and recruiter |

An HR Admin approved what candidates see, so after approval only an HR Admin
changes it. A recruiter sees those fields locked, with a note saying why.

A hiring manager edits the jobs they requested while they're drafts, also
while awaiting approval, but not once approved. A recruiter starts once a job
is approved ([hiring roles](hiring-roles.md)).

Closed jobs can't be edited.

## What a change affects

- **Careers page:** a published job's changes show at once.
- **Posts already shared:** LinkedIn posts aren't changed. **Post to
  channels** shares the job again; the careers website channel updates the
  job it already has ([careers website](careers-website-publishing.md)).
- **Resume screening:** new applications are screened with the new criteria.
  Applicants already screened keep their score, and their screening says it
  used older criteria; **Screen again** uses the new ones
  ([resume screening](resume-screening.md)).
- **AI calls:** new calls ask the new questions. Calls already planned or
  made keep the questions they were planned with
  ([AI call questions](ai-call-questions.md)).
- **Interviews:** an interview keeps the criteria it was scheduled with, for
  its feedback.

The audit log records each edit (`job.updated`) with the job's status and the
fields that changed.

## API

`PATCH /api/v1/jobs/:id` (HR Admin, recruiter) takes any job fields, for any
job but a closed one (`409`). On an approved or published job, a recruiter
changing a field candidates see gets `403`; sending those fields unchanged is
fine.
