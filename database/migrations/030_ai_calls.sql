-- AI calls. A recruiter asks for a call; during calling hours HireAI dials the
-- candidate from the organization's Plivo number and an AI voice asks the
-- job's call questions. The recruiter reads the answers. A call never changes
-- an application's stage.

-- Which voice AI talks to candidates, chosen by an HR Admin (null: automatic).
ALTER TABLE organization_ai_settings
 ADD COLUMN calling_provider text CHECK (calling_provider IN ('openai','google_ai'));
GRANT UPDATE(calling_provider) ON organization_ai_settings TO hireai_app;

-- A call request now goes through to a result. Requests planned before calls
-- could be placed have no next_attempt_at, so they are never dialed.
ALTER TABLE call_requests
 -- The questions as they were when the call was requested, so later job edits
 -- don't change what was asked.
 ADD COLUMN questions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(questions)='array'),
 ADD COLUMN next_attempt_at timestamptz,
 ADD COLUMN attempts smallint NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
 ADD COLUMN max_attempts smallint NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
 ADD COLUMN outcome text CHECK (outcome IN ('COMPLETED','DECLINED','WRONG_PERSON','UNREACHED','FAILED')),
 ADD COLUMN failure text CHECK (length(failure) <= 40),
 ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN completed_at timestamptz,
 ADD CONSTRAINT call_requests_outcome_check2
  CHECK ((status IN ('COMPLETED','FAILED')) = (outcome IS NOT NULL));
CREATE INDEX call_requests_application_idx
 ON call_requests(tenant_id, application_id, created_at DESC);
CREATE INDEX call_requests_due_idx
 ON call_requests(tenant_id, next_attempt_at) WHERE status='PLANNED';
GRANT UPDATE(next_attempt_at,attempts,outcome,failure,updated_at,completed_at,recording,transcription)
 ON call_requests TO hireai_app;

-- One row per time HireAI dials. Answers, transcript and recording come from
-- the call itself, so they're erased with the candidate.
CREATE TABLE call_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 call_request_id uuid NOT NULL,
 number smallint NOT NULL CHECK (number BETWEEN 1 AND 10),
 status text NOT NULL DEFAULT 'DIALING'
  CHECK (status IN ('DIALING','IN_PROGRESS','COMPLETED','NO_ANSWER','FAILED','CANCELLED')),
 -- The organization's phone connection (Plivo) used for this call.
 connection_id uuid NOT NULL,
 provider_request_id text CHECK (length(provider_request_id) <= 100),
 provider_call_id text CHECK (length(provider_call_id) <= 100),
 voice_provider text CHECK (voice_provider IN ('openai','google_ai')),
 voice_model text CHECK (length(voice_model) <= 100),
 -- What the candidate's consent allowed when this call was dialed.
 recording boolean NOT NULL DEFAULT false,
 transcription boolean NOT NULL DEFAULT false,
 answered_at timestamptz,
 ended_at timestamptz,
 duration_seconds integer CHECK (duration_seconds BETWEEN 0 AND 86400),
 hangup_cause text CHECK (length(hangup_cause) <= 100),
 outcome text CHECK (outcome IN ('COMPLETED','DECLINED','CALL_BACK','WRONG_PERSON','NO_RESPONSE')),
 answers jsonb CHECK (jsonb_typeof(answers)='array'),
 summary text CHECK (length(summary) <= 2000),
 callback_note text CHECK (length(callback_note) <= 300),
 transcript jsonb CHECK (jsonb_typeof(transcript)='array'),
 recording_key text CHECK (recording_key ~ '^[a-f0-9-]{36}/[a-f0-9-]{36}$'),
 recording_version text CHECK (length(recording_version) <= 1024),
 recording_bytes integer CHECK (recording_bytes > 0),
 failure text CHECK (length(failure) <= 40),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (tenant_id, id),
 UNIQUE (tenant_id, call_request_id, number),
 FOREIGN KEY (tenant_id, call_request_id) REFERENCES call_requests(tenant_id, id),
 FOREIGN KEY (tenant_id, connection_id) REFERENCES integration_configs(tenant_id, id),
 CHECK (transcript IS NULL OR transcription),
 CHECK (recording_key IS NULL OR recording)
);
CREATE INDEX call_attempts_request_idx ON call_attempts(tenant_id, call_request_id, number DESC);
CREATE INDEX call_attempts_open_idx ON call_attempts(tenant_id, status, created_at)
 WHERE status IN ('DIALING','IN_PROGRESS');
ALTER TABLE call_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_attempts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON call_attempts
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
-- DELETE is for candidate erasure only.
GRANT SELECT,INSERT,DELETE ON call_attempts TO hireai_app;
GRANT UPDATE(status,provider_request_id,provider_call_id,voice_provider,voice_model,answered_at,
 ended_at,duration_seconds,hangup_cause,outcome,answers,summary,callback_note,transcript,
 recording_key,recording_version,recording_bytes,failure,updated_at)
 ON call_attempts TO hireai_app;

-- Which organizations have calls waiting or in progress, so the dispatcher
-- knows where to look without a BYPASSRLS role. It holds no call details,
-- and the runtime role can't read it directly (as public_tenant_directory).
CREATE TABLE call_dispatch_directory (
 organization_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE
);
REVOKE ALL ON call_dispatch_directory FROM PUBLIC,hireai_app;
CREATE FUNCTION sync_call_dispatch_directory() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
DECLARE
 org uuid;
BEGIN
 IF TG_OP='DELETE' THEN org := OLD.tenant_id; ELSE org := NEW.tenant_id; END IF;
 -- Runs in the writer's tenant context, so RLS shows only that organization.
 IF EXISTS (
   SELECT 1 FROM public.call_requests WHERE tenant_id=org
     AND (status='IN_PROGRESS' OR (status='PLANNED' AND next_attempt_at IS NOT NULL))
 ) THEN
   INSERT INTO public.call_dispatch_directory(organization_id) VALUES(org)
   ON CONFLICT DO NOTHING;
 ELSE
   DELETE FROM public.call_dispatch_directory WHERE organization_id=org;
 END IF;
 RETURN NULL;
END $fn$;
REVOKE ALL ON FUNCTION sync_call_dispatch_directory() FROM PUBLIC,hireai_app;
CREATE TRIGGER call_requests_dispatch_directory
 AFTER INSERT OR DELETE OR UPDATE OF status,next_attempt_at ON call_requests
 FOR EACH ROW EXECUTE FUNCTION sync_call_dispatch_directory();
CREATE FUNCTION call_dispatch_organizations(max_count integer) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $fn$
 SELECT organization_id FROM public.call_dispatch_directory
 ORDER BY organization_id LIMIT least(greatest(max_count,1),1000)
$fn$;
REVOKE ALL ON FUNCTION call_dispatch_organizations(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION call_dispatch_organizations(integer) TO hireai_app;
