-- Job requests: a hiring manager (or recruiter) drafts a job and submits it
-- for approval; an HR Admin approves it, or sends it back with a note; a
-- recruiter (or HR Admin) then publishes it.
ALTER TABLE jobs
 -- Submitted for approval (null: still being drafted, or sent back).
 ADD COLUMN requested_at timestamptz,
 -- Why an HR Admin sent it back, until it's submitted again or approved.
 ADD COLUMN review_note text
 CHECK (review_note IS NULL OR length(review_note) BETWEEN 1 AND 1000);
CREATE INDEX jobs_awaiting_approval_idx ON jobs(tenant_id, requested_at)
 WHERE status = 'DRAFT' AND requested_at IS NOT NULL;
GRANT UPDATE(requested_at, review_note) ON jobs TO hireai_app;
