-- Only public routing metadata is copied; runtime cannot SELECT this directory.
-- It avoids a BYPASSRLS role or a permissive policy on forced-RLS tenants.
ALTER TABLE tenants ADD COLUMN slug text;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
UPDATE tenants SET slug='tenant-'||id::text;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenants ALTER COLUMN slug SET NOT NULL;
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$');
ALTER TABLE tenants ADD CONSTRAINT tenants_slug_unique UNIQUE(slug);
CREATE TABLE public_tenant_directory (
 slug text PRIMARY KEY,
 resolved_id uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE
);
REVOKE ALL ON public_tenant_directory FROM PUBLIC,hireai_app;
ALTER TABLE tenants NO FORCE ROW LEVEL SECURITY;
INSERT INTO public_tenant_directory(slug,resolved_id) SELECT slug,id FROM tenants;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE FUNCTION prepare_tenant_slug() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
 IF NEW.slug IS NULL THEN NEW.slug := 'tenant-'||NEW.id::text; END IF;
 RETURN NEW;
END $fn$;
CREATE TRIGGER tenants_prepare_slug BEFORE INSERT ON tenants FOR EACH ROW EXECUTE FUNCTION prepare_tenant_slug();
CREATE FUNCTION sync_public_tenant_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
BEGIN
 INSERT INTO public.public_tenant_directory(slug,resolved_id) VALUES(NEW.slug,NEW.id)
 ON CONFLICT(resolved_id) DO UPDATE SET slug=EXCLUDED.slug;
 RETURN NEW;
END $fn$;
REVOKE ALL ON FUNCTION prepare_tenant_slug(),sync_public_tenant_directory() FROM PUBLIC,hireai_app;
CREATE TRIGGER tenants_sync_directory AFTER INSERT OR UPDATE OF slug ON tenants FOR EACH ROW EXECUTE FUNCTION sync_public_tenant_directory();
CREATE FUNCTION resolve_public_tenant(requested_slug text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT resolved_id FROM public.public_tenant_directory WHERE slug=requested_slug
$fn$;
REVOKE ALL ON FUNCTION resolve_public_tenant(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_public_tenant(text) TO hireai_app;

ALTER TABLE candidates ADD COLUMN erased_at timestamptz;
ALTER TABLE consents ALTER COLUMN captured_by DROP NOT NULL;
ALTER TABLE consents ADD COLUMN notice_version text, ADD COLUMN ip_address inet,
 ADD COLUMN user_agent_hash text, ADD COLUMN verified boolean NOT NULL DEFAULT true;
ALTER TABLE consents ADD CONSTRAINT public_consent_evidence_check CHECK
 (verified OR (source='public-careers' AND notice_version IS NOT NULL AND ip_address IS NOT NULL AND user_agent_hash IS NOT NULL AND captured_by IS NULL));
CREATE TABLE candidate_documents (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 candidate_id uuid NOT NULL, object_key text NOT NULL, storage_version text, original_name text NOT NULL,
 content_type text NOT NULL CHECK(content_type IN ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')),
 byte_size integer NOT NULL CHECK(byte_size>0), sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),
 scan_status text NOT NULL DEFAULT 'PENDING', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,object_key),
 FOREIGN KEY(tenant_id,candidate_id) REFERENCES candidates(tenant_id,id)
);
CREATE INDEX candidate_documents_candidate_idx ON candidate_documents(tenant_id,candidate_id,created_at DESC);
CREATE TABLE public_intake_limits (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 bucket_key text NOT NULL CHECK(bucket_key ~ '^[a-f0-9]{64}$'), window_start timestamptz NOT NULL,
 hits integer NOT NULL CHECK(hits>0), UNIQUE(tenant_id,id), UNIQUE(tenant_id,bucket_key,window_start)
);
CREATE INDEX public_intake_limits_expiry_idx ON public_intake_limits(tenant_id,window_start);
CREATE INDEX candidates_retention_idx ON candidates(tenant_id,updated_at,id) WHERE erased_at IS NULL;
DO $rls$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['candidate_documents','public_intake_limits'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format($policy$CREATE POLICY tenant_isolation ON public.%I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,tab);
 END LOOP;
END $rls$;
GRANT SELECT,INSERT,DELETE ON candidate_documents TO hireai_app;
GRANT SELECT,INSERT,DELETE ON public_intake_limits TO hireai_app;
GRANT UPDATE(hits) ON public_intake_limits TO hireai_app;
GRANT UPDATE(full_name,email,phone,erased_at,updated_at) ON candidates TO hireai_app;
-- Evidence tables still have only SELECT and INSERT privileges.

GRANT UPDATE(original_name) ON candidate_documents TO hireai_app;

ALTER TABLE consents ADD CONSTRAINT consent_actor_evidence_check CHECK(captured_by IS NOT NULL OR source='public-careers');
