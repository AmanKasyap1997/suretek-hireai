-- Which AI provider the organization uses for resume screening, chosen by an
-- HR Admin in Integrations. No row, or no provider, means automatic: the
-- enabled providers in HireAI's order, each falling back to the next.
CREATE TABLE organization_ai_settings (
 tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
 screening_provider text CHECK (screening_provider IN ('openai','anthropic','google_ai')),
 -- With a chosen provider: whether another enabled provider may screen when
 -- it can't be used. Off keeps every candidate scored by the same AI.
 screening_fallback boolean NOT NULL DEFAULT true,
 updated_by uuid NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id)
);
ALTER TABLE organization_ai_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_ai_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_ai_settings
 USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
 WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
GRANT SELECT,INSERT ON organization_ai_settings TO hireai_app;
GRANT UPDATE(screening_provider,screening_fallback,updated_by,updated_at)
 ON organization_ai_settings TO hireai_app;
