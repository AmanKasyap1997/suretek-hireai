-- Which connected calendar interviews go in when Google Calendar and Microsoft
-- Calendar are both connected, chosen by an HR Admin. Null: Google Calendar.
-- The AI's interview booking uses the same calendar.
ALTER TABLE organization_ai_settings
 ADD COLUMN interview_calendar text
 CHECK (interview_calendar IN ('google_calendar','microsoft_calendar'));
GRANT UPDATE(interview_calendar) ON organization_ai_settings TO hireai_app;
