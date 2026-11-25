-- A resume sent with a public application belongs to that application, so a
-- candidate who applies to several jobs keeps one resume per application, and
-- a later application never replaces the resume on an earlier one. Resumes
-- staff upload to a candidate have no application.
ALTER TABLE candidate_documents ADD COLUMN application_id uuid;
ALTER TABLE candidate_documents ADD CONSTRAINT candidate_documents_application_fk
 FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id);
CREATE INDEX candidate_documents_application_idx
 ON candidate_documents(tenant_id, application_id) WHERE application_id IS NOT NULL;

-- Earlier public applications saved their resume in the same transaction as
-- the application, so both rows carry that transaction's timestamp.
-- Temporarily let the owner backfill all tenants; FORCE is restored before commit.
ALTER TABLE candidate_documents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE applications NO FORCE ROW LEVEL SECURITY;
UPDATE candidate_documents d SET application_id=a.id
 FROM applications a
 WHERE a.tenant_id=d.tenant_id AND a.candidate_id=d.candidate_id
   AND a.created_at=d.created_at AND d.application_id IS NULL;
ALTER TABLE applications FORCE ROW LEVEL SECURITY;
ALTER TABLE candidate_documents FORCE ROW LEVEL SECURITY;
