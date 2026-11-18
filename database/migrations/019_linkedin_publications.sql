ALTER TABLE integration_configs ADD CONSTRAINT integration_configs_tenant_id_unique UNIQUE(tenant_id,id);
-- Frozen previews and durable dispatch state prevent duplicate external posts.
CREATE TABLE integration_publications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 job_id uuid NOT NULL, connection_id uuid NOT NULL,
 channel text NOT NULL CHECK(channel IN ('company_announcement','job_listing')),
 payload jsonb NOT NULL, job_updated_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','SENDING','SUBMITTED','PUBLISHED','PROCESSED','FAILED','UNKNOWN')),
 remote_id text, remote_url text, error_code text, created_by uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(tenant_id,connection_id) REFERENCES integration_configs(tenant_id,id),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 FOREIGN KEY(tenant_id,created_by) REFERENCES users(tenant_id,id)
);
CREATE INDEX integration_publications_tenant ON integration_publications(tenant_id,created_at DESC);
CREATE UNIQUE INDEX integration_publications_one_dispatch ON integration_publications(tenant_id,job_id,channel)
 WHERE status IN ('SENDING','SUBMITTED','PUBLISHED','PROCESSED','UNKNOWN');
ALTER TABLE integration_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_publications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_publications
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,UPDATE ON integration_publications TO hireai_app;
