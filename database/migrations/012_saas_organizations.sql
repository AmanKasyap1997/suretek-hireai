-- SaaS control plane is opt-in: no existing tenant receives platform privileges.
ALTER TABLE tenants ADD COLUMN is_platform boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX tenants_one_platform ON tenants ((true)) WHERE is_platform;
ALTER TABLE users ADD COLUMN invitation_pending boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD CONSTRAINT users_pending_inactive CHECK (NOT invitation_pending OR NOT active);

CREATE TABLE user_invitations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 user_id uuid NOT NULL,
 token_hash text NOT NULL CHECK (token_hash ~ '^[a-f0-9]{64}$'),
 expires_at timestamptz NOT NULL,
 accepted_at timestamptz,
 revoked_at timestamptz,
 delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING','SENT','FAILED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,token_hash),
 FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE UNIQUE INDEX user_invitations_pending ON user_invitations(tenant_id,user_id)
 WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX user_invitations_user ON user_invitations(tenant_id,user_id,created_at DESC);

-- tenant_id is the platform's own scope; organization_id is its provisioned tenant.
-- This deliberate cross-tenant control-plane relationship exposes creation metadata
-- only. No business records are copied or made visible to the platform account.
CREATE TABLE platform_organizations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 organization_id uuid NOT NULL UNIQUE REFERENCES tenants(id),
 admin_user_id uuid NOT NULL,
 name text NOT NULL,
 slug text NOT NULL UNIQUE,
 admin_email text NOT NULL,
 admin_name text NOT NULL,
 last_invitation_id uuid NOT NULL,
 delivery_status text NOT NULL DEFAULT 'PENDING' CHECK (delivery_status IN ('PENDING','SENT','FAILED')),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(organization_id,admin_user_id) REFERENCES users(tenant_id,id),
 FOREIGN KEY(organization_id,last_invitation_id) REFERENCES user_invitations(tenant_id,id),
 CHECK(tenant_id <> organization_id)
);
CREATE INDEX platform_organizations_scope ON platform_organizations(tenant_id,created_at DESC,id);
DO $rls$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['user_invitations','platform_organizations'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format($policy$CREATE POLICY tenant_isolation ON public.%I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,tab);
 END LOOP;
END $rls$;
REVOKE ALL ON user_invitations,platform_organizations FROM PUBLIC,hireai_app;
GRANT SELECT,INSERT ON user_invitations TO hireai_app;
GRANT UPDATE(token_hash,expires_at,accepted_at,revoked_at,delivery_status) ON user_invitations TO hireai_app;
GRANT SELECT ON platform_organizations TO hireai_app;
GRANT UPDATE(last_invitation_id,delivery_status) ON platform_organizations TO hireai_app;
GRANT UPDATE(password_hash,invitation_pending) ON users TO hireai_app;

-- Only this narrow, role-checking operation can create a tenant at runtime.
-- The definer is the migration/table owner, with FORCE RLS still enabled.
CREATE FUNCTION provision_organization(
 actor_user uuid, display_name text, slug_key text, admin_name text,
 admin_email text, secret_hash text, deadline timestamptz
) RETURNS TABLE(organization_id uuid, admin_id uuid, invitation_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 scope uuid := nullif(current_setting('app.tenant_id',true),'')::uuid;
 org uuid := gen_random_uuid();
 member uuid := gen_random_uuid();
 invite uuid := gen_random_uuid();
BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM public.users u JOIN public.tenants t ON t.id=u.tenant_id
   WHERE u.tenant_id=scope AND u.id=actor_user AND u.role='SUPER_ADMIN'
     AND u.active AND t.is_platform
 ) THEN RAISE EXCEPTION 'Platform administrator required' USING ERRCODE='42501'; END IF;
 IF secret_hash !~ '^[a-f0-9]{64}$' OR deadline<=now() OR deadline>now()+interval '7 days' THEN
   RAISE EXCEPTION 'Invalid invitation' USING ERRCODE='22023';
 END IF;
 PERFORM set_config('app.tenant_id',org::text,true);
 INSERT INTO public.tenants(id,name,slug) VALUES(org,display_name,slug_key);
 INSERT INTO public.users(id,tenant_id,email,password_hash,full_name,role,active,invitation_pending)
 VALUES(member,org,lower(admin_email),'!invitation-pending',admin_name,'HR_ADMIN',false,true);
 INSERT INTO public.user_invitations(id,tenant_id,user_id,token_hash,expires_at)
 VALUES(invite,org,member,secret_hash,deadline);
 INSERT INTO public.audit_events(tenant_id,actor_id,action,entity_type,entity_id,metadata)
 VALUES(org,NULL,'organization.provisioned','user',member,'{}');
 PERFORM set_config('app.tenant_id',scope::text,true);
 INSERT INTO public.platform_organizations(tenant_id,organization_id,admin_user_id,name,slug,admin_email,admin_name,last_invitation_id)
 VALUES(scope,org,member,display_name,slug_key,lower(admin_email),admin_name,invite);
 INSERT INTO public.audit_events(tenant_id,actor_id,action,entity_type,entity_id,metadata)
 VALUES(scope,actor_user,'organization.created','organization',org,'{}');
 RETURN QUERY SELECT org,member,invite;
END $fn$;
REVOKE ALL ON FUNCTION provision_organization(uuid,text,text,text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION provision_organization(uuid,text,text,text,text,text,timestamptz) TO hireai_app;
