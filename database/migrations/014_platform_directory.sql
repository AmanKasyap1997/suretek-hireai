-- Keep bootstrap-after-upgrade installs visible without granting platform users
-- SELECT access to tenant business tables. This directory contains metadata only.
ALTER TABLE public_tenant_directory ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
UPDATE public_tenant_directory d SET metadata=jsonb_build_object('name',t.name,'is_platform',t.is_platform,'created_at',t.created_at) FROM tenants t WHERE t.id=d.resolved_id;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE OR REPLACE FUNCTION sync_public_tenant_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 INSERT INTO public.public_tenant_directory(slug,resolved_id,metadata) VALUES(NEW.slug,NEW.id,jsonb_build_object('name',NEW.name,'is_platform',NEW.is_platform,'created_at',NEW.created_at))
 ON CONFLICT(resolved_id) DO UPDATE SET slug=EXCLUDED.slug,metadata=EXCLUDED.metadata;
 RETURN NEW;
END $$;
DROP TRIGGER tenants_sync_directory ON tenants;
CREATE TRIGGER tenants_sync_directory AFTER INSERT OR UPDATE OF slug,name,is_platform ON tenants FOR EACH ROW EXECUTE FUNCTION sync_public_tenant_directory();
CREATE FUNCTION register_existing_organizations(actor_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE scope uuid := nullif(current_setting('app.tenant_id',true),'')::uuid;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenants t ON t.id=u.tenant_id WHERE u.id=actor_user AND u.tenant_id=scope AND u.active AND u.role='SUPER_ADMIN' AND t.is_platform)
 THEN RAISE EXCEPTION 'Platform administrator required' USING ERRCODE='42501'; END IF;
 WITH inserted AS (
 INSERT INTO public.platform_organizations(tenant_id,organization_id,name,slug,created_at,created_by)
 SELECT scope,resolved_id,metadata->>'name',slug,(metadata->>'created_at')::timestamptz,actor_user FROM public.public_tenant_directory
 WHERE metadata->>'is_platform'='false' ON CONFLICT(organization_id) DO NOTHING RETURNING organization_id)
 INSERT INTO public.audit_events(tenant_id,actor_id,action,entity_type,entity_id) SELECT scope,actor_user,'organization.imported','organization',organization_id FROM inserted;
END $$;
REVOKE ALL ON FUNCTION register_existing_organizations(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION register_existing_organizations(uuid) TO hireai_app;
GRANT DELETE ON user_roles TO hireai_app;
GRANT UPDATE(role) ON users TO hireai_app;
ALTER TABLE user_invitations ADD COLUMN invited_by uuid;
