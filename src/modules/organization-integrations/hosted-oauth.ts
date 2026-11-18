import { ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Provider } from './catalog';
export function hostedOAuth(provider: Provider) {
  const prefix = 'OAUTH_' + provider.toUpperCase();
  const clientId = process.env[prefix + '_CLIENT_ID'],
    clientSecret = process.env[prefix + '_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}
export function oauthFingerprint(credentials: {
  clientId: string;
  clientSecret: string;
}) {
  return createHash('sha256')
    .update(credentials.clientId + '\0' + credentials.clientSecret)
    .digest('hex');
}
export function effectiveCredentials(
  provider: Provider,
  credentials: Record<string, string>,
) {
  if (credentials._hosted !== 'true') return credentials;
  const app = hostedOAuth(provider);
  if (!app || app.clientId !== credentials.clientId)
    throw new ServiceUnavailableException(
      'Provider application changed; reconnect',
    );
  return { ...credentials, ...app };
}
