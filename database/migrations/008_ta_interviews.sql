-- Trusted PostgreSQL extension: installed by the database owner, without a
-- SUPERUSER/BYPASSRLS runtime role, for UUID equality in GiST exclusion indexes.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;

CREATE TABLE interviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  application_id uuid NOT NULL,
  round text NOT NULL CHECK (length(trim(round)) BETWEEN 1 AND 100),
  mode text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  location text CHECK (location IS NULL OR length(trim(location)) BETWEEN 1 AND 1000),
  meeting_url text CHECK (meeting_url IS NULL OR length(meeting_url) BETWEEN 1 AND 2000),
  status text NOT NULL DEFAULT 'SCHEDULED',
  criteria_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(criteria_snapshot) = 'array'),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, id),
  -- Panelist reservations reference the complete current schedule. Changing
  -- times/status cascades into reservations inside the same database statement.
  UNIQUE (tenant_id, id, starts_at, ends_at, status),
  FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
  CONSTRAINT interviews_time_order_check CHECK (ends_at > starts_at)
);
CREATE INDEX interviews_application_idx ON interviews(tenant_id, application_id, starts_at DESC, id);
CREATE INDEX interviews_schedule_idx ON interviews(tenant_id, status, starts_at, id);

CREATE TABLE interview_panelists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  interview_id uuid NOT NULL,
  user_id uuid NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, interview_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
  FOREIGN KEY (tenant_id, interview_id, starts_at, ends_at, status)
    REFERENCES interviews(tenant_id, id, starts_at, ends_at, status)
    ON UPDATE CASCADE,
  CONSTRAINT interview_panelists_time_order_check CHECK (ends_at > starts_at),
  -- Half-open intervals permit adjacent interviews; cancelled interviews do not
  -- reserve a panelist. Exclusion checks also serialize concurrent scheduling.
  CONSTRAINT interview_panelists_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    user_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status = 'SCHEDULED')
);
CREATE INDEX interview_panelists_user_idx ON interview_panelists(tenant_id, user_id, starts_at, id);

CREATE TABLE interview_scorecards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  interview_id uuid NOT NULL,
  panelist_user_id uuid NOT NULL,
  scores jsonb NOT NULL CHECK (jsonb_typeof(scores) = 'array'),
  recommendation text NOT NULL,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 5000),
  submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, interview_id, panelist_user_id),
  FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews(tenant_id, id),
  -- Immutable submissions retain their actual panel membership as evidence.
  FOREIGN KEY (tenant_id, interview_id, panelist_user_id)
    REFERENCES interview_panelists(tenant_id, interview_id, user_id)
);
CREATE INDEX interview_scorecards_interview_idx ON interview_scorecards(tenant_id, interview_id, submitted_at, id);

CREATE INDEX application_stage_events_reporting_idx
  ON application_stage_events(tenant_id, created_at, application_id, to_stage);

DO $rls$
DECLARE tab text;
BEGIN
  FOREACH tab IN ARRAY ARRAY['interviews', 'interview_panelists', 'interview_scorecards'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tab);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', tab);
    EXECUTE format(
      $policy$CREATE POLICY tenant_isolation ON public.%I
        USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
        WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$policy$,
      tab
    );
  END LOOP;
END
$rls$;

GRANT SELECT, INSERT ON interviews TO hireai_app;
GRANT UPDATE (round, mode, starts_at, ends_at, location, meeting_url, status, updated_at)
  ON interviews TO hireai_app;
-- Parent FK cascades maintain reservation times/status; runtime cannot edit
-- denormalized fields directly. Submitted scorecards prevent panel removal.
GRANT SELECT, INSERT, DELETE ON interview_panelists TO hireai_app;
GRANT SELECT, INSERT ON interview_scorecards TO hireai_app;
