-- The name the AI introduces itself with on calls ("Hi, this is Priya from
-- ..."), set by an HR Admin. Null: it introduces itself by the organization.
ALTER TABLE organization_ai_settings
 ADD COLUMN calling_assistant_name text CHECK (
   char_length(calling_assistant_name) BETWEEN 1 AND 40
   AND calling_assistant_name !~ '[[:cntrl:]]'
 );
GRANT UPDATE(calling_assistant_name) ON organization_ai_settings TO hireai_app;
