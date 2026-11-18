# AI provider authorization setup

The Integrations and Super Admin provider cards include a three-step setup guide
for OpenAI and Anthropic. API-key connections remain supported. These guides do
not register applications, store credentials, or activate OAuth. Enabling a
provider makes its implemented connection methods available; it does not enable
an unimplemented authorization adapter.

## OpenAI

1. Request commercial application access and confirm the supported model-usage
   contract with OpenAI. Identity-only Sign in with ChatGPT does not authorize
   model inference.
2. Register the application and exact callbacks. Retain its client ID, approved
   scopes, authentication method, and any confidential-client credentials in
   server-side secret storage.
3. Implement the approved flow before offering authorization to organizations:
   state and PKCE, OIDC signature/issuer/audience/nonce validation where required,
   granted scope checks, encrypted token storage, refresh, verification, and
   disconnection. Match inference requests and billing to the granted permissions.

The documented open-source app flow uses a loopback listener and local credential
storage. It is not a drop-in replacement for this hosted multi-tenant application.

- [Client registration](https://developers.openai.com/siwc/request-client-id)
- [Website authorization](https://developers.openai.com/siwc/website)
- [Open-source authorization](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)

## Anthropic

1. Review Claude Platform OAuth linked billing eligibility and beta requirements.
   A customer's directly billed API organization is required; a personal Claude
   subscription alone is insufficient. Review the provider's data-handling rules.
2. A Claude Console administrator registers an OAuth application with “Bill and
   link to organizations”, its callback, and an identity provider for signed
   client authentication. Configure operator credentials, customer user profiles,
   test users, and app review as described in the provider guide.
3. Implement its provider-specific adapter: pushed authorization requests, PKCE,
   private-key JWT client authentication, JSON token exchange, refresh, customer
   profile association, billing attribution, verification, and disconnection.
   Anthropic does not issue a conventional OAuth client secret for this flow.

- [Registration and linked billing](https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections)
- [Protocol reference](https://platform.claude.com/docs/en/manage-claude/oauth-apps/oauth-reference)

## Deployment handoff

Use the actual deployed public origin, not the administrator's browser origin.
The existing callback path is `/console/integrations/oauth`; the developer must
confirm the full registered URL and adapt callback handling for each approved
provider flow. Do not add unused AI OAuth environment variables or reuse the
Google/Microsoft client-secret adapter for these protocols.

Application registration does not automatically make these AI integrations ready.
The AI authorization adapters remain unimplemented in this build. Before launch,
test cancellation, wrong/expired/reused state, tenant isolation, missing scopes,
token refresh/revocation, provider configuration changes, and billing attribution
with provider test accounts. Keep the current API-key option throughout setup.
