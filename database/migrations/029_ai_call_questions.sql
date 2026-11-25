-- AI calling: an HR Admin's switch, and the questions each job's AI call asks.
-- Calls aren't placed yet; the switch lets recruiters prepare the questions.
ALTER TABLE organization_ai_settings ADD COLUMN calling_enabled boolean NOT NULL DEFAULT false;
GRANT UPDATE(calling_enabled) ON organization_ai_settings TO hireai_app;

-- [{id, text, answer_type, expected_answer, criterion_id}], at most 10. Staff
-- only: never part of the public job listing.
ALTER TABLE jobs ADD COLUMN call_questions jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK (jsonb_typeof(call_questions)='array' AND jsonb_array_length(call_questions) <= 10);
GRANT UPDATE(call_questions) ON jobs TO hireai_app;
