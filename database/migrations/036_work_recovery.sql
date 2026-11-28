-- Every organization's id, for the API's sweep that picks up resume
-- screenings and call assessments a restart left behind (their queues are in
-- memory). Ids only: the runtime role can't read the directory itself, and
-- every lookup after this runs in that organization's tenant context.
CREATE FUNCTION recovery_organizations(max_count integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT resolved_id FROM public.public_tenant_directory
 ORDER BY resolved_id LIMIT least(greatest(max_count,1),10000)
$fn$;
REVOKE ALL ON FUNCTION recovery_organizations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION recovery_organizations(integer) TO hireai_app;
