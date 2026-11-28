-- Automatic hiring steps an HR Admin turns on. Candidates only ever move
-- forward automatically; nobody is rejected. Null scores: the step is off.
ALTER TABLE organization_ai_settings
 ADD COLUMN auto_shortlist_score smallint CHECK (auto_shortlist_score BETWEEN 1 AND 100),
 ADD COLUMN auto_call_shortlisted boolean NOT NULL DEFAULT false,
 ADD COLUMN auto_interview_score smallint CHECK (auto_interview_score BETWEEN 1 AND 100);
GRANT UPDATE(auto_shortlist_score,auto_call_shortlisted,auto_interview_score)
 ON organization_ai_settings TO hireai_app;

-- How the AI books a job's interviews: round, length, type, panel and the
-- days and hours to offer.
ALTER TABLE jobs
 ADD COLUMN interview_setup jsonb CHECK (interview_setup IS NULL OR jsonb_typeof(interview_setup)='object');
GRANT UPDATE(interview_setup) ON jobs TO hireai_app;

-- A call is the screening call or the one that books the interview. Calls
-- HireAI places by itself have no requester.
ALTER TABLE call_requests
 ALTER COLUMN requested_by DROP NOT NULL,
 ADD COLUMN purpose text NOT NULL DEFAULT 'SCREENING' CHECK (purpose IN ('SCREENING','SCHEDULING'));

-- The interview times offered on a booking call, and the interview it booked.
ALTER TABLE call_attempts
 ADD COLUMN slots jsonb CHECK (slots IS NULL OR jsonb_typeof(slots)='array'),
 ADD COLUMN booked_interview_id uuid;
GRANT UPDATE(booked_interview_id) ON call_attempts TO hireai_app;

-- An interview booked by the AI call has no creator, and has an event in the
-- organization's connected calendar.
ALTER TABLE interviews
 ALTER COLUMN created_by DROP NOT NULL,
 ADD COLUMN calendar_provider text CHECK (calendar_provider IN ('google_calendar','microsoft_calendar')),
 ADD COLUMN calendar_event_id text CHECK (length(calendar_event_id) <= 1024);
GRANT UPDATE(calendar_provider,calendar_event_id) ON interviews TO hireai_app;
