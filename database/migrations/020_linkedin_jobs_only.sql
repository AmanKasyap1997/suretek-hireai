-- Retire Company Pages connections and prevent pending feed announcements from
-- being dispatched. Keep publication rows as historical audit records.
-- Migration ownership normally bypasses RLS, but FORCE ROW LEVEL SECURITY also
-- applies to table owners. Temporarily remove FORCE inside this transaction.
ALTER TABLE integration_configs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_providers NO FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_publications NO FORCE ROW LEVEL SECURITY;

UPDATE integration_configs
SET status='unverified',
    encrypted_credentials='',
    credential_hint='Disconnected',
    last_verified_at=NULL,
    updated_at=now()
WHERE provider='linkedin';

UPDATE integration_providers
SET enabled=false,
    revision=revision+CASE WHEN enabled THEN 1 ELSE 0 END,
    updated_at=now()
WHERE provider='linkedin';

UPDATE integration_publications
SET status='FAILED',
    error_code='FEATURE_REMOVED',
    updated_at=now()
WHERE channel='company_announcement' AND status='DRAFT';

ALTER TABLE integration_configs FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_providers FORCE ROW LEVEL SECURITY;
ALTER TABLE integration_publications FORCE ROW LEVEL SECURITY;
