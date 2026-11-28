-- After a call, the organization's screening AI rates each answer against the
-- question's key points, and HireAI computes a score from the ratings. It's a
-- suggestion for the recruiter: it never changes an application's stage.
-- Derived from the candidate's answers, so it's erased with the call attempt.
ALTER TABLE call_attempts
 ADD COLUMN assessment jsonb CHECK (jsonb_typeof(assessment)='object'),
 ADD COLUMN assessment_status text CHECK (assessment_status IN ('PENDING','COMPLETED','FAILED')),
 ADD COLUMN assessed_at timestamptz;
GRANT UPDATE(assessment,assessment_status,assessed_at) ON call_attempts TO hireai_app;
