-- Failed logins without a valid organization still need append-only evidence.
-- Resolve only the platform directory and insert a fixed event; accept no user
-- input or tenant identifiers and expose no tenant records to the caller.
CREATE FUNCTION audit_unresolved_login() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE previous_scope text := current_setting('app.tenant_id',true);
DECLARE platform_id uuid;
BEGIN
 SELECT resolved_id INTO platform_id FROM public.public_tenant_directory
 WHERE metadata->>'is_platform'='true' ORDER BY slug LIMIT 1;
 IF platform_id IS NULL THEN RETURN; END IF;
 PERFORM set_config('app.tenant_id',platform_id::text,true);
 INSERT INTO public.audit_events(tenant_id,action,entity_type,metadata)
 VALUES(platform_id,'auth.login_failed','user','{"reason":"unresolved_organization"}');
 PERFORM set_config('app.tenant_id',coalesce(previous_scope,''),true);
END $$;
REVOKE ALL ON FUNCTION audit_unresolved_login() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audit_unresolved_login() TO hireai_app;
