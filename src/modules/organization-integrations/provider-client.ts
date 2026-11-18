import {
  OAuthExchangeError,
  rejectedExchange,
  transportFailure,
} from './oauth-errors';
import { BadRequestException } from '@nestjs/common';
import nodemailer from 'nodemailer';
import { Method, Provider } from './catalog';
import { effectiveCredentials } from './hosted-oauth';
export const oauthEndpoints = {
  linkedin: {
    authorize: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    scope: 'rw_organization_admin w_organization_social',
    pkce: false,
  },
  google_calendar: {
    pkce: true,
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope:
      'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  },
  microsoft_calendar: {
    pkce: true,
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'offline_access https://graph.microsoft.com/Calendars.ReadWrite',
  },
};
function trustedUrl(value: string | undefined) {
  if (!value)
    throw new BadRequestException(
      'The operator must configure this provider endpoint',
    );
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new BadRequestException('Provider endpoint must be trusted HTTPS');
  return url.toString();
}
export function callbackUrl() {
  const origin = process.env.PUBLIC_WEB_BASE_URL;
  if (!origin)
    throw new BadRequestException('PUBLIC_WEB_BASE_URL is required for OAuth');
  const url = new URL('/console/integrations/oauth', origin);
  if (
    url.protocol !== 'https:' &&
    !(
      process.env.NODE_ENV !== 'production' &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    )
  )
    throw new BadRequestException('OAuth requires HTTPS');
  return url.toString();
}
export async function exchange(provider: Provider, body: URLSearchParams) {
  const endpoint =
    provider === 'linkedin_jobs'
      ? 'https://www.linkedin.com/oauth/v2/accessToken'
      : provider in oauthEndpoints
        ? oauthEndpoints[provider as keyof typeof oauthEndpoints].token
        : trustedUrl(
            process.env[`INTEGRATION_${provider.toUpperCase()}_TOKEN_URL`],
          );
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
  } catch (error) {
    throw transportFailure(error);
  }
  if (!response.ok) throw await rejectedExchange(response);
  let data: {
    access_token?: unknown;
    refresh_token?: unknown;
    expires_in?: unknown;
  } | null;
  try {
    data = await response.json();
  } catch {
    throw new OAuthExchangeError('invalid_response');
  }
  if (
    !data ||
    typeof data.access_token !== 'string' ||
    !data.access_token ||
    data.access_token.length > 16384
  )
    throw new OAuthExchangeError('invalid_response');
  return {
    accessToken: data.access_token,
    ...(typeof data.expires_in === 'number' &&
    data.expires_in > 0 &&
    Number.isFinite(data.expires_in)
      ? { expiresAt: String(Date.now() + data.expires_in * 1000) }
      : {}),
    ...(typeof data.refresh_token === 'string' &&
    data.refresh_token.length <= 16384
      ? { refreshToken: data.refresh_token }
      : {}),
  };
}
export async function verify(
  provider: Provider,
  method: Method,
  credentials: Record<string, string>,
) {
  credentials = effectiveCredentials(provider, credentials);
  if (method === 'smtp') {
    // Host/port are deployment-owned, never browser supplied (prevents SMTP SSRF).
    const host = process.env.INTEGRATION_EMAIL_SMTP_HOST;
    const port = Number(process.env.INTEGRATION_EMAIL_SMTP_PORT || 465);
    if (!host || ![465, 587].includes(port))
      throw new BadRequestException(
        'Operator must configure SMTP host and port 465 or 587',
      );
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      requireTLS: true,
      tls: { rejectUnauthorized: true },
      auth: { user: credentials.username, pass: credentials.password },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 10000,
    });
    try {
      await transport.verify();
      return { ok: true, credentials };
    } finally {
      transport.close();
    }
  }
  if (provider === 'linkedin_jobs') {
    if (process.env.LINKEDIN_JOBS_APPROVED !== 'true')
      throw new BadRequestException(
        'LinkedIn Jobs partner approval is required',
      );
    const tokens = await exchange(
      provider,
      new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
    );
    return { ok: true, credentials: { ...credentials, ...tokens } };
  }
  const fixed: Partial<Record<Provider, string>> = {
    linkedin:
      'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=1',
    openai: 'https://api.openai.com/v1/models',
    anthropic: 'https://api.anthropic.com/v1/models',
    google_calendar:
      'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1',
    microsoft_calendar: 'https://graph.microsoft.com/v1.0/me/calendars?$top=1',
  };
  const endpoint =
    fixed[provider] ??
    trustedUrl(process.env[`INTEGRATION_${provider.toUpperCase()}_VERIFY_URL`]);
  let token = credentials.accessToken;
  if (
    method === 'oauth_client_credentials' ||
    method === 'oauth_refresh_token' ||
    method === 'oauth2'
  ) {
    if (method === 'oauth2' && !credentials.refreshToken)
      token = credentials.accessToken;
    else {
      const body = new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type:
          method === 'oauth_client_credentials'
            ? 'client_credentials'
            : 'refresh_token',
      });
      if (credentials.refreshToken)
        body.set('refresh_token', credentials.refreshToken);
      if (credentials.scope) body.set('scope', credentials.scope);
      const refreshed = await exchange(provider, body);
      credentials = { ...credentials, ...refreshed };
      token = refreshed.accessToken;
    }
  }
  const headers: Record<string, string> =
    provider === 'linkedin'
      ? {
          'LinkedIn-Version':
            process.env.LINKEDIN_MARKETING_VERSION || '202611',
          'X-Restli-Protocol-Version': '2.0.0',
        }
      : {};
  if (method === 'basic')
    headers.Authorization =
      'Basic ' +
      Buffer.from(credentials.username + ':' + credentials.password).toString(
        'base64',
      );
  else if (method === 'api_key') {
    if (provider === 'openai')
      headers.Authorization = 'Bearer ' + credentials.apiKey;
    else if (provider === 'anthropic') {
      headers['x-api-key'] = credentials.apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else {
      const header =
        process.env[`INTEGRATION_${provider.toUpperCase()}_API_KEY_HEADER`] ||
        'X-API-Key';
      if (
        !/^[A-Za-z0-9-]+$/.test(header) ||
        /^(host|cookie|content-length)$/i.test(header)
      )
        throw new BadRequestException('Invalid API key header configuration');
      headers[header] = credentials.apiKey;
    }
  } else headers.Authorization = 'Bearer ' + token;
  try {
    const response = await fetch(endpoint, {
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    await response.body?.cancel();
    if (credentials._hosted === 'true') delete credentials.clientSecret;
    return { ok: response.ok, credentials };
  } catch {
    // A successful token refresh may rotate the refresh token even if the
    // subsequent verification request fails. Preserve the new credentials.
    if (credentials._hosted === 'true') delete credentials.clientSecret;
    return { ok: false, credentials };
  }
}
