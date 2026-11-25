-- LinkedIn posts removed through HireAI (directly, or when the job closes).
-- REMOVED is outside the one-dispatch index, so the job can be posted again.
ALTER TABLE integration_publications DROP CONSTRAINT integration_publications_status_check;
ALTER TABLE integration_publications ADD CONSTRAINT integration_publications_status_check
 CHECK(status IN ('DRAFT','SENDING','SUBMITTED','PUBLISHED','PROCESSED','FAILED','UNKNOWN','REMOVED'));
