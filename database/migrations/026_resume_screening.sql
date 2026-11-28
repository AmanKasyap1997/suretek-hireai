-- AI resume screening. The organization's AI provider rates a resume against
-- the job's screening criteria; HireAI computes the score from the criteria
-- weights. A screening is advice for a recruiter: it never changes a stage.

-- Screen new applications automatically (when an AI provider is enabled).
ALTER TABLE jobs ADD COLUMN auto_screen boolean NOT NULL DEFAULT true;
GRANT UPDATE(auto_screen) ON jobs TO hireai_app;

-- One row per screening run; screening again adds a row, so earlier results
-- stay as evidence. The newest row is the current one.
CREATE TABLE application_screenings (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 application_id uuid NOT NULL,
 document_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
 trigger text NOT NULL CHECK (trigger IN ('AUTOMATIC','MANUAL','BATCH')),
 requested_by uuid,
 -- The job's criteria when the screening was requested ([] = none on the job).
 criteria jsonb NOT NULL CHECK (jsonb_typeof(criteria)='array'),
 provider text CHECK (length(provider) <= 40),
 environment text CHECK (environment IN ('production','sandbox')),
 model text CHECK (length(model) <= 200),
 score smallint CHECK (score BETWEEN 0 AND 100),
 fit text CHECK (fit IN ('STRONG','GOOD','PARTIAL','WEAK')),
 missing_must_have boolean,
 -- Per-criterion ratings with evidence, summary, strengths, concerns and
 -- suggested questions. Derived from the resume, so erased with the candidate.
 result jsonb CHECK (jsonb_typeof(result)='object'),
 failure text CHECK (length(failure) <= 40),
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 completed_at timestamptz,
 UNIQUE (tenant_id, id),
 FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
 FOREIGN KEY (tenant_id, document_id) REFERENCES candidate_documents(tenant_id, id),
 FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id),
 CHECK ((status='COMPLETED') = (score IS NOT NULL AND fit IS NOT NULL AND result IS NOT NULL AND missing_must_have IS NOT NULL)),
 CHECK ((status='FAILED') = (failure IS NOT NULL)),
 CHECK (trigger='AUTOMATIC' OR requested_by IS NOT NULL)
);
CREATE INDEX application_screenings_application_idx
 ON application_screenings(tenant_id, application_id, created_at DESC, id DESC);
-- At most one queued or running screening per application.
CREATE UNIQUE INDEX application_screenings_active_idx
 ON application_screenings(tenant_id, application_id) WHERE status IN ('QUEUED','RUNNING');
ALTER TABLE application_screenings ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_screenings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON application_screenings
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- DELETE is for candidate erasure only.
GRANT SELECT,INSERT,DELETE ON application_screenings TO hireai_app;
GRANT UPDATE(status,provider,environment,model,score,fit,missing_must_have,result,failure,started_at,completed_at)
 ON application_screenings TO hireai_app;
