-- What a candidate entered on the apply form, kept per application: a repeat
-- applicant never overwrites an existing candidate's profile anonymously.
-- Pay and contact details live here, not on applications, so the shared
-- application lists don't expose them.
CREATE TABLE application_details (
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 application_id uuid NOT NULL,
 phone text CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
 current_location text NOT NULL CHECK (length(trim(current_location)) BETWEEN 2 AND 120),
 willing_to_relocate boolean,
 total_experience_months integer NOT NULL CHECK (total_experience_months BETWEEN 0 AND 720),
 current_company text CHECK (length(current_company) <= 200),
 current_title text CHECK (length(current_title) <= 200),
 notice_period text NOT NULL CHECK (notice_period IN
  ('IMMEDIATE','DAYS_15','DAYS_30','DAYS_45','DAYS_60','DAYS_90','OVER_90_DAYS','SERVING_NOTICE')),
 last_working_day date CHECK (last_working_day IS NULL OR notice_period='SERVING_NOTICE'),
 current_ctc numeric(14,2) CHECK (current_ctc >= 0),
 expected_ctc numeric(14,2) NOT NULL CHECK (expected_ctc > 0),
 ctc_currency varchar(3) NOT NULL DEFAULT 'INR' CHECK (ctc_currency ~ '^[A-Z]{3}$'),
 linkedin_url text CHECK (length(linkedin_url) <= 300),
 portfolio_url text CHECK (length(portfolio_url) <= 300),
 cover_letter text CHECK (length(cover_letter) <= 4000),
 source text NOT NULL DEFAULT 'DIRECT' CHECK (source IN
  ('DIRECT','CAREERS_SITE','LINKEDIN','REFERRAL','JOB_PORTAL','SOCIAL','OTHER')),
 referrer text CHECK (referrer IS NULL OR (source='REFERRAL' AND length(referrer) <= 200)),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id, application_id),
 FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id)
);
CREATE INDEX application_details_source_idx ON application_details(tenant_id, source);
ALTER TABLE application_details ENABLE ROW LEVEL SECURITY;
ALTER TABLE application_details FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON application_details
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- DELETE is for candidate erasure; details are never edited after submission.
GRANT SELECT,INSERT,DELETE ON application_details TO hireai_app;
