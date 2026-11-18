-- Keep tenant-scoped OAuth cleanup and provider-policy ownership lookups indexed.
CREATE INDEX integration_oauth_states_tenant_user_expiry
 ON integration_oauth_states(tenant_id,user_id,expires_at);
CREATE INDEX integration_providers_tenant ON integration_providers(tenant_id);
