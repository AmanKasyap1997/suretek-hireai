ALTER TABLE candidate_documents ADD COLUMN scanned_at timestamptz,
 ADD COLUMN scan_attempts integer NOT NULL DEFAULT 0 CHECK(scan_attempts BETWEEN 0 AND 100),
 ADD COLUMN scan_error text CHECK(length(scan_error)<=100), ADD COLUMN quarantined_at timestamptz;
GRANT UPDATE(scan_status,scanned_at,scan_attempts,scan_error,quarantined_at) ON candidate_documents TO hireai_app;
CREATE INDEX candidate_documents_scan_idx ON candidate_documents(tenant_id,scan_status,scan_attempts,created_at,id);
CREATE FUNCTION guard_document_quarantine() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,pg_temp AS $$
BEGIN
 IF TG_OP='UPDATE' AND (OLD.scan_status='INFECTED' OR OLD.quarantined_at IS NOT NULL) AND (NEW.scan_status<>'INFECTED' OR NEW.quarantined_at IS NULL) THEN RAISE EXCEPTION 'Quarantine is permanent' USING ERRCODE='23514'; END IF;
 IF NEW.scan_status='INFECTED' THEN NEW.quarantined_at=coalesce(NEW.quarantined_at,clock_timestamp()); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION guard_document_quarantine() FROM PUBLIC;
CREATE TRIGGER candidate_document_quarantine BEFORE INSERT OR UPDATE ON candidate_documents FOR EACH ROW EXECUTE FUNCTION guard_document_quarantine();
CREATE TABLE contact_verifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),tenant_id uuid NOT NULL REFERENCES tenants(id),candidate_id uuid NOT NULL,
 application_id uuid NOT NULL,token_hash text NOT NULL CHECK(token_hash ~ '^[a-f0-9]{64}$'),email_hash text NOT NULL CHECK(email_hash ~ '^[a-f0-9]{64}$'),
 call_consent_id uuid NOT NULL,recording_consent_id uuid NOT NULL,transcription_consent_id uuid NOT NULL,
 expires_at timestamptz NOT NULL,used_at timestamptz,attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id),FOREIGN KEY(tenant_id,candidate_id) REFERENCES candidates(tenant_id,id),
 FOREIGN KEY(tenant_id,application_id) REFERENCES applications(tenant_id,id),
 FOREIGN KEY(tenant_id,call_consent_id) REFERENCES consents(tenant_id,id),
 FOREIGN KEY(tenant_id,recording_consent_id) REFERENCES consents(tenant_id,id),
 FOREIGN KEY(tenant_id,transcription_consent_id) REFERENCES consents(tenant_id,id)
);
CREATE INDEX contact_verifications_candidate_idx ON contact_verifications(tenant_id,candidate_id,expires_at,id);
ALTER TABLE contact_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_verifications USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON contact_verifications TO hireai_app;
GRANT UPDATE(used_at,attempts) ON contact_verifications TO hireai_app;
ALTER TABLE consents ADD COLUMN verification_method text,ADD COLUMN verification_id uuid;
ALTER TABLE consents ADD FOREIGN KEY(tenant_id,verification_id) REFERENCES contact_verifications(tenant_id,id);
ALTER TABLE consents ADD CONSTRAINT consent_verification_pair CHECK((verification_method IS NULL)=(verification_id IS NULL));
ALTER TABLE consents ADD CONSTRAINT consent_email_verification CHECK(verification_id IS NULL OR (verified AND source='public-careers' AND captured_by IS NULL AND notice_version IS NOT NULL));
