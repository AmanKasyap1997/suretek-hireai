-- RLS is defense in depth alongside explicit tenant predicates in application SQL.
-- The runtime must SET LOCAL app.tenant_id inside every tenant transaction.
DO $rls$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT relation.relname
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attname = 'tenant_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', target.relname);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', target.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON public.%I FOR ALL TO PUBLIC
       USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)
       WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      target.relname
    );
  END LOOP;
END
$rls$;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.tenants;
CREATE POLICY tenant_isolation ON public.tenants FOR ALL TO PUBLIC
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);

-- Database and table ownership remain with the migration role. Applications
-- receive only the table/column operations used by the starter's current SQL.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;

DO $grants$
DECLARE
  target record;
BEGIN
  -- Table-level REVOKE does not remove pre-existing column-level grants.
  FOR target IN
    SELECT relation.relname,
           string_agg(quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum) AS columns
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    GROUP BY relation.relname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM PUBLIC', target.columns, target.relname);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hireai_app') THEN
    RAISE NOTICE 'hireai_app does not exist. Run database/init/01-create-roles.sh before applying this migration to grant runtime access.';
    RETURN;
  END IF;

  REVOKE ALL PRIVILEGES ON SCHEMA public FROM hireai_app;
  REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM hireai_app;
  REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM hireai_app;
  FOR target IN
    SELECT relation.relname,
           string_agg(quote_ident(attribute.attname), ', ' ORDER BY attribute.attnum) AS columns
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    GROUP BY relation.relname
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE public.%I FROM hireai_app', target.columns, target.relname);
  END LOOP;

  GRANT USAGE ON SCHEMA public TO hireai_app;
  GRANT SELECT ON public.tenants TO hireai_app;
  -- PostgreSQL requires UPDATE privilege for SELECT ... FOR UPDATE row locks.
  GRANT UPDATE (id) ON public.tenants TO hireai_app;
  GRANT SELECT, INSERT ON public.users TO hireai_app;
  GRANT UPDATE (active) ON public.users TO hireai_app;
  GRANT SELECT, INSERT ON public.jobs TO hireai_app;
  GRANT UPDATE (title, description, department, location, status, updated_at) ON public.jobs TO hireai_app;
  GRANT SELECT, INSERT ON public.candidates TO hireai_app;
  -- Candidate locking serializes consent changes and call planning.
  GRANT UPDATE (id) ON public.candidates TO hireai_app;
  GRANT SELECT, INSERT ON public.applications TO hireai_app;
  GRANT UPDATE (stage, updated_at) ON public.applications TO hireai_app;
  GRANT SELECT, INSERT ON public.offers TO hireai_app;
  GRANT UPDATE (status, approved_by, accepted_at, acceptance_reference, updated_at) ON public.offers TO hireai_app;
  GRANT SELECT, INSERT ON public.employees TO hireai_app;
  GRANT SELECT, INSERT ON public.onboarding_tasks TO hireai_app;
  GRANT UPDATE (completed) ON public.onboarding_tasks TO hireai_app;
  GRANT SELECT, INSERT ON public.consents TO hireai_app;
  GRANT SELECT, INSERT ON public.call_requests TO hireai_app;
  GRANT UPDATE (status) ON public.call_requests TO hireai_app;
  GRANT SELECT, INSERT ON public.leave_requests TO hireai_app;
  GRANT UPDATE (status, reviewed_by) ON public.leave_requests TO hireai_app;
  GRANT SELECT, INSERT ON public.attendance TO hireai_app;
  GRANT SELECT, INSERT ON public.audit_events TO hireai_app;
  GRANT USAGE ON SEQUENCE public.consents_sequence_id_seq TO hireai_app;
END
$grants$;
