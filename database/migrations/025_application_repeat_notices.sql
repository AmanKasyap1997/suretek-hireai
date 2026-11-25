-- When a candidate who applies again to the same job was last emailed
-- "you've already applied". HireAI sends it at most once a day per
-- application, so the public form can't be used to flood someone's inbox.
-- Holds no personal data.
CREATE TABLE application_repeat_notices (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 application_id uuid NOT NULL,
 sent_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, application_id),
 FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id)
);
ALTER TABLE application_repeat_notices ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_repeat_notices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON application_repeat_notices
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON application_repeat_notices TO hireai_app;
GRANT UPDATE(sent_at) ON application_repeat_notices TO hireai_app;
