-- Additive TA data; existing migrations remain immutable.
ALTER TABLE jobs
 ADD COLUMN openings integer NOT NULL DEFAULT 1 CHECK (openings > 0),
 ADD COLUMN employment_type text NOT NULL DEFAULT 'FULL_TIME',
 ADD COLUMN salary_min numeric(14,2) CHECK (salary_min >= 0),
 ADD COLUMN salary_max numeric(14,2) CHECK (salary_max >= 0),
 ADD COLUMN hiring_manager_user_id uuid,
 ADD COLUMN screening_criteria jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(screening_criteria)='array'),
 ADD COLUMN closed_at timestamptz,
 ADD COLUMN close_reason text,
 ADD CONSTRAINT jobs_salary_band_check CHECK (salary_min IS NULL OR salary_max IS NULL OR salary_max >= salary_min),
 ADD FOREIGN KEY (tenant_id,hiring_manager_user_id) REFERENCES users(tenant_id,id);
UPDATE jobs SET closed_at=updated_at WHERE status='CLOSED';
CREATE TABLE job_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id), job_id uuid NOT NULL, user_id uuid NOT NULL,
 role text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,job_id,user_id,role),
 FOREIGN KEY(tenant_id,job_id) REFERENCES jobs(tenant_id,id),
 FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id)
);
CREATE INDEX job_assignments_user_idx ON job_assignments(tenant_id,user_id,job_id);
CREATE TABLE application_stage_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id),
 application_id uuid NOT NULL, from_stage text, to_stage text NOT NULL,
 reason_code text, note text, actor_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_id) REFERENCES users(tenant_id,id)
);
-- Temporarily let the owner backfill all tenants inside this migration transaction.
-- FORCE is restored before commit; runtime roles never own this table.
ALTER TABLE applications NO FORCE ROW LEVEL SECURITY;
INSERT INTO application_stage_events(tenant_id,application_id,to_stage,reason_code,note,created_at)
 SELECT tenant_id,id,stage,CASE WHEN stage='REJECTED' THEN 'OTHER' END,'Initial migrated state',created_at FROM applications;
ALTER TABLE applications FORCE ROW LEVEL SECURITY;
ALTER TABLE application_stage_events ADD CONSTRAINT stage_rejection_evidence_check CHECK(to_stage<>'REJECTED' OR reason_code IS NOT NULL);
CREATE INDEX application_stage_events_history_idx ON application_stage_events(tenant_id,application_id,created_at,id);
ALTER TABLE offers ADD COLUMN expires_at timestamptz;
ALTER TABLE offers DROP CONSTRAINT offers_tenant_id_application_id_key;
CREATE UNIQUE INDEX offers_one_active_idx ON offers(tenant_id,application_id)
 WHERE status IN ('DRAFT','APPROVED','ACCEPTED');
CREATE INDEX jobs_tenant_created_idx ON jobs(tenant_id,created_at DESC,id);
CREATE INDEX applications_tenant_job_idx ON applications(tenant_id,job_id,created_at DESC,id);
DO $rls$
DECLARE tab text;
BEGIN
 FOREACH tab IN ARRAY ARRAY['job_assignments','application_stage_events'] LOOP
 EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tab);
 EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tab);
 EXECUTE format($policy$CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)$policy$,tab);
 END LOOP;
END $rls$;
GRANT SELECT,INSERT,DELETE ON job_assignments TO hireai_app;
GRANT SELECT,INSERT ON application_stage_events TO hireai_app;
GRANT UPDATE(openings,employment_type,salary_min,salary_max,hiring_manager_user_id,screening_criteria,closed_at,close_reason) ON jobs TO hireai_app;
