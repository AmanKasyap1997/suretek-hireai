// Only fixed, actionable messages may cross the provider/API boundary. Never
// return error_description, response bodies, URLs or raw fetch error messages.
const messages = {
  invalid_client:
    'OAuth client authentication failed (invalid_client). Check the backend client ID and client secret belong to the same provider application, then restart the backend and authorize again.',
  invalid_grant:
    'The provider rejected the authorization code (invalid_grant). Start a fresh authorization. If this repeats, check the OAuth client and exact redirect URI configured for the backend.',
  redirect_uri_mismatch:
    'The provider rejected the redirect URI (redirect_uri_mismatch). Register the exact callback URI shown in Google authorization setup and restart the backend after configuration changes.',
  unauthorized_client:
    'This OAuth client is not permitted to use this authorization flow (unauthorized_client). Check the provider application type and access policy.',
  access_denied:
    'The provider denied token exchange (access_denied). Check the provider application access policy and test-user access.',
  invalid_scope:
    'The provider rejected the requested permissions (invalid_scope). Check the provider application scopes.',
  invalid_request:
    'The provider rejected the token exchange request (invalid_request). Check the OAuth application configuration and start a new authorization.',
  unsupported_grant_type:
    'The provider does not support this token exchange flow (unsupported_grant_type). Check the OAuth application configuration.',
  provider_unavailable:
    'The provider token endpoint is temporarily unavailable (oauth_provider_unavailable). Try a fresh authorization later.',
  rate_limited:
    'The provider token endpoint is rate limited (oauth_rate_limited). Wait before starting a fresh authorization.',
  tls_error:
    'The backend could not verify the provider TLS certificate (oauth_tls_error). Check Node.js certificate trust and any corporate HTTPS proxy; keep certificate verification enabled.',
  dns_error:
    'The backend could not resolve the provider token endpoint (oauth_dns_error). Check DNS and outbound network access on the backend machine.',
  timeout:
    'The backend timed out contacting the provider token endpoint (oauth_timeout). Check outbound network/proxy access, then start a fresh authorization.',
  network_error:
    'The backend could not reach the provider token endpoint (oauth_network_error). Check outbound HTTPS and proxy configuration on the backend machine.',
  invalid_response:
    'The provider returned an invalid token response (oauth_invalid_response). Check any outbound proxy and start a fresh authorization.',
  exchange_failed:
    'Provider authentication failed (oauth_exchange_failed). Start a fresh authorization and check the provider application configuration.',
} as const;
export type OAuthFailureCode = keyof typeof messages;
export class OAuthExchangeError extends Error {
  constructor(readonly code: OAuthFailureCode) {
    super(messages[code]);
    this.name = 'OAuthExchangeError';
  }
}
export function oauthFailureResponse(error: unknown) {
  const failure =
    error instanceof OAuthExchangeError
      ? error
      : new OAuthExchangeError('exchange_failed');
  return { code: failure.code, message: failure.message };
}
export function transportFailure(error: unknown): OAuthExchangeError {
  const value = error as {
    name?: string;
    code?: string;
    cause?: { code?: string };
  } | null;
  const code = value?.cause?.code ?? value?.code;
  if (
    value?.name === 'TimeoutError' ||
    value?.name === 'AbortError' ||
    [
      'ETIMEDOUT',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
    ].includes(code ?? '')
  )
    return new OAuthExchangeError('timeout');
  if (
    [
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
      'UNABLE_TO_GET_ISSUER_CERT',
      'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      'SELF_SIGNED_CERT_IN_CHAIN',
      'DEPTH_ZERO_SELF_SIGNED_CERT',
      'CERT_HAS_EXPIRED',
      'CERT_NOT_YET_VALID',
      'ERR_TLS_CERT_ALTNAME_INVALID',
    ].includes(code ?? '')
  )
    return new OAuthExchangeError('tls_error');
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(code ?? ''))
    return new OAuthExchangeError('dns_error');
  return new OAuthExchangeError('network_error');
}
export async function rejectedExchange(
  response: Response,
): Promise<OAuthExchangeError> {
  // Bound the error body and never retain or return its descriptions. A proxy
  // can return arbitrary HTML or reflect submitted credentials in an error.
  const reader = response.body?.getReader();
  let error: unknown;
  if (reader) {
    try {
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 8192) {
          await reader.cancel();
          break;
        }
        chunks.push(part.value);
      }
      if (size <= 8192)
        error = JSON.parse(Buffer.concat(chunks).toString('utf8'))?.error;
    } catch {
      /* Malformed/error responses must not escape into logs or UI. */
    } finally {
      reader.releaseLock();
    }
  }
  if (
    typeof error === 'string' &&
    [
      'invalid_client',
      'invalid_grant',
      'redirect_uri_mismatch',
      'unauthorized_client',
      'access_denied',
      'invalid_scope',
      'invalid_request',
      'unsupported_grant_type',
    ].includes(error)
  )
    return new OAuthExchangeError(error as OAuthFailureCode);
  if (response.status === 429) return new OAuthExchangeError('rate_limited');
  if (response.status >= 500)
    return new OAuthExchangeError('provider_unavailable');
  return new OAuthExchangeError('exchange_failed');
}
