-- The voice the AI uses on calls, chosen by an HR Admin (null: the server's
-- default for the voice AI in use).
ALTER TABLE organization_ai_settings
 ADD COLUMN calling_voice text CHECK (calling_voice ~ '^[A-Za-z]{2,40}$');
GRANT UPDATE(calling_voice) ON organization_ai_settings TO hireai_app;
