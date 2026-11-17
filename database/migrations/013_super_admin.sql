-- Extend the existing organization/RLS model without moving tenant records.
ALTER TABLE tenants ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('trial','active','suspended')),
 ADD COLUMN enabled_modules jsonb NOT NULL DEFAULT '["hiring","core_hr","leave","attendance","onboarding"]',
 ADD COLUMN deleted_at timestamptz;
ALTER TABLE platform_organizations ALTER COLUMN admin_user_id DROP NOT NULL,
 ALTER COLUMN last_invitation_id DROP NOT NULL,
 ALTER COLUMN admin_email DROP NOT NULL, ALTER COLUMN admin_name DROP NOT NULL,
 ADD COLUMN domain text UNIQUE, ADD COLUMN country text NOT NULL DEFAULT '',
 ADD COLUMN timezone text NOT NULL DEFAULT 'UTC', ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK(status IN ('trial','active','suspended')),
 ADD COLUMN plan text NOT NULL DEFAULT 'standard',
 ADD COLUMN enabled_modules jsonb NOT NULL DEFAULT '["hiring","core_hr","leave","attendance","onboarding"]',
 ADD COLUMN limits jsonb NOT NULL DEFAULT '{"max_users":100,"call_minutes_per_month":1000,"storage_mb":10240}',
 ADD COLUMN trial_ends_at timestamptz, ADD COLUMN suspended_at timestamptz,
 ADD COLUMN suspended_reason text, ADD COLUMN deleted_at timestamptz,
 ADD COLUMN created_by uuid, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX platform_organizations_filters ON platform_organizations(tenant_id,status,plan,created_at);
-- Existing installs already have tenant IDs on all business records. Register their
-- metadata only, preserving ownership and every existing ID. RLS restored before commit.
ALTER TABLE tenants DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform_organizations DISABLE ROW LEVEL SECURITY;
INSERT INTO platform_organizations(tenant_id,organization_id,name,slug)
 SELECT p.id,t.id,t.name,t.slug FROM tenants t CROSS JOIN tenants p
 WHERE p.is_platform AND NOT t.is_platform ON CONFLICT(organization_id) DO NOTHING;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ADD COLUMN last_login_at timestamptz,
 ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
 ADD COLUMN status text GENERATED ALWAYS AS (CASE WHEN invitation_pending THEN 'invited' WHEN active THEN 'active' ELSE 'disabled' END) STORED;
CREATE TABLE user_roles(tenant_id uuid NOT NULL, user_id uuid NOT NULL, role text NOT NULL,
 PRIMARY KEY(tenant_id,user_id,role), FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE CASCADE,
 CHECK(role IN ('SUPER_ADMIN','HR_ADMIN','RECRUITER','HIRING_MANAGER','INTERVIEWER','CANDIDATE','EMPLOYEE','REPORTING_MANAGER','PAYROLL_FINANCE','IT_ASSET_ADMIN')));
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
INSERT INTO user_roles SELECT tenant_id,id,role FROM users;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION sync_primary_role() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 INSERT INTO public.user_roles(tenant_id,user_id,role) VALUES(NEW.tenant_id,NEW.id,NEW.role) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER users_primary_role AFTER INSERT OR UPDATE OF role ON users FOR EACH ROW EXECUTE FUNCTION sync_primary_role();
CREATE TABLE integration_configs(
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 organization_id uuid REFERENCES tenants(id), scope text NOT NULL CHECK(scope IN ('platform','organization')),
 provider text NOT NULL, environment text NOT NULL CHECK(environment IN ('sandbox','production')),
 status text NOT NULL DEFAULT 'unverified' CHECK(status IN ('unverified','ok','failing','enabled')),
 encrypted_credentials text NOT NULL, credential_hint text NOT NULL,
 last_verified_at timestamptz, updated_by uuid NOT NULL, error_count integer NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((scope='platform' AND organization_id IS NULL) OR (scope='organization' AND organization_id IS NOT NULL)));
CREATE UNIQUE INDEX integration_identity ON integration_configs(tenant_id,provider,environment,coalesce(organization_id,'00000000-0000-0000-0000-000000000000'::uuid));
CREATE TABLE platform_settings(tenant_id uuid NOT NULL REFERENCES tenants(id), key text NOT NULL, value jsonb NOT NULL,
 updated_by uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,key));
ALTER TABLE audit_events ADD COLUMN ip text, ADD COLUMN user_agent text;
CREATE INDEX audit_events_platform_filter ON audit_events(tenant_id,action,created_at DESC);
ALTER TABLE call_requests ADD COLUMN duration_seconds integer CHECK(duration_seconds>=0);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['user_roles','integration_configs','platform_settings'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',tab);
 END LOOP;
END $$;
GRANT SELECT,INSERT ON user_roles TO hireai_app;
GRANT SELECT,INSERT,UPDATE ON integration_configs,platform_settings TO hireai_app;
GRANT UPDATE(last_login_at,must_change_password) ON users TO hireai_app;
GRANT UPDATE(name,domain,country,timezone,status,plan,enabled_modules,limits,trial_ends_at,suspended_at,suspended_reason,deleted_at,updated_at,created_by) ON platform_organizations TO hireai_app;
-- Controlled mutation of tenant governance fields only; no access to tenant PII.
CREATE FUNCTION govern_organization(actor_user uuid, org uuid, next_name text, next_status text, modules jsonb, deleted timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE scope uuid := nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.id=u.tenant_id WHERE u.id=actor_user AND u.tenant_id=scope AND u.active AND u.role='SUPER_ADMIN' AND t.is_platform)
 OR NOT EXISTS(SELECT 1 FROM public.platform_organizations WHERE tenant_id=scope AND organization_id=org)
 THEN RAISE EXCEPTION 'Platform administrator required' USING ERRCODE='42501'; END IF;
 PERFORM set_config('app.tenant_id',org::text,true);
 UPDATE public.tenants SET name=next_name,status=next_status,enabled_modules=modules,deleted_at=deleted WHERE id=org AND NOT is_platform;
 PERFORM set_config('app.tenant_id',scope::text,true);
END $$;
REVOKE ALL ON FUNCTION govern_organization(uuid,uuid,text,text,jsonb,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION govern_organization(uuid,uuid,text,text,jsonb,timestamptz) TO hireai_app;

-- Non-secret global governance defaults are readable by authenticated runtime queries.
CREATE POLICY defaults_read ON platform_settings FOR SELECT USING (key='defaults');
