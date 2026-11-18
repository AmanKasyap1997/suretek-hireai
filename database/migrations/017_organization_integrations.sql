-- Non-secret platform provider catalog; organization credentials keep existing forced RLS.
CREATE TABLE integration_providers (
 provider text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 enabled boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1,
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE integration_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY provider_read ON integration_providers FOR SELECT USING (true);
CREATE POLICY tenant_isolation ON integration_providers FOR ALL
 USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM tenants WHERE id=tenant_id AND is_platform))
 WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(SELECT 1 FROM tenants WHERE id=tenant_id AND is_platform));
GRANT SELECT,INSERT,UPDATE ON integration_providers TO hireai_app;
ALTER TABLE integration_configs ADD COLUMN method text NOT NULL DEFAULT 'bearer',
 ADD COLUMN provider_revision integer NOT NULL DEFAULT 0;
CREATE TABLE integration_oauth_states (
 tenant_id uuid NOT NULL REFERENCES tenants(id), state_hash text PRIMARY KEY,
 user_id uuid NOT NULL, encrypted_payload text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE
);
ALTER TABLE integration_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_oauth_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON integration_oauth_states
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT,DELETE ON integration_oauth_states TO hireai_app;
