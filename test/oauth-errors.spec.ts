import { BadRequestException } from '@nestjs/common';
import { exchange } from '../src/modules/organization-integrations/provider-client';
import {
  oauthFailureResponse,
  OAuthExchangeError,
} from '../src/modules/organization-integrations/oauth-errors';
import { OrganizationIntegrationsService } from '../src/modules/organization-integrations/organization-integrations.service';
import { encryptSecret } from '../src/modules/super-admin/secrets';
import { DbService } from '../src/platform/database/db.service';
import { Role } from '../src/shared/actor';

afterEach(() => jest.restoreAllMocks());
it.each([
  'invalid_client',
  'invalid_grant',
  'redirect_uri_mismatch',
  'invalid_scope',
  'invalid_request',
  'unauthorized_client',
  'access_denied',
  'unsupported_grant_type',
])(
  'reports %s without leaking provider descriptions or credentials',
  async (code) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          error: code,
          error_description: 'client_secret=private-secret code=private-code',
          access_token: 'private-token',
        },
        { status: 400 },
      ),
    );
    const error = await exchange(
      'google_calendar',
      new URLSearchParams({ client_secret: 'private-secret' }),
    ).catch((e) => e);
    expect(error).toBeInstanceOf(OAuthExchangeError);
    expect(oauthFailureResponse(error).code).toBe(code);
    expect(JSON.stringify(oauthFailureResponse(error))).not.toContain(
      'private-',
    );
  },
);
it.each([
  ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls_error'],
  ['SELF_SIGNED_CERT_IN_CHAIN', 'tls_error'],
  ['ENOTFOUND', 'dns_error'],
  ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
  ['ECONNREFUSED', 'network_error'],
])('classifies backend transport failure %s', async (code, expected) => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockRejectedValue(
      new TypeError('private-code private-secret', { cause: { code } }),
    );
  const error = await exchange('google_calendar', new URLSearchParams()).catch(
    (e) => e,
  );
  expect(oauthFailureResponse(error).code).toBe(expected);
  expect(JSON.stringify(oauthFailureResponse(error))).not.toContain('private-');
});
it.each([
  [429, 'rate_limited'],
  [503, 'provider_unavailable'],
  [400, 'exchange_failed'],
])(
  'classifies HTTP %s with an untrusted error body',
  async (status, expected) => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('private-secret', { status: status as number }),
      );
    const error = await exchange(
      'google_calendar',
      new URLSearchParams(),
    ).catch((e) => e);
    expect(oauthFailureResponse(error).code).toBe(expected);
    expect(JSON.stringify(oauthFailureResponse(error))).not.toContain(
      'private-secret',
    );
  },
);
it('rejects oversized error payloads without returning reflected secrets', async () => {
  jest.spyOn(globalThis, 'fetch').mockResolvedValue(
    Response.json(
      {
        error: 'invalid_client',
        error_description: 'private-secret'.repeat(1000),
      },
      { status: 400 },
    ),
  );
  const error = await exchange('google_calendar', new URLSearchParams()).catch(
    (e) => e,
  );
  expect(oauthFailureResponse(error).code).toBe('exchange_failed');
  expect(JSON.stringify(oauthFailureResponse(error))).not.toContain(
    'private-secret',
  );
});
it.each(['not-json', 'null', '{}'])(
  'rejects malformed successful token responses safely: %s',
  async (body) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(body));
    const error = await exchange(
      'google_calendar',
      new URLSearchParams(),
    ).catch((e) => e);
    expect(oauthFailureResponse(error).code).toBe('invalid_response');
  },
);
it('sanitizes unexpected exceptions', () => {
  expect(oauthFailureResponse(new Error('private-client-secret'))).toEqual({
    code: 'exchange_failed',
    message: expect.not.stringContaining('private-client-secret'),
  });
});
it('preserves the safe provider failure in the callback API response', async () => {
  const previous = process.env.INTEGRATION_ENCRYPTION_KEY;
  process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
  try {
    const actor = { tenantId: 'org', userId: 'admin', role: Role.HR_ADMIN };
    const payload = encryptSecret(
      JSON.stringify({
        input: {
          provider: 'google_calendar',
          environment: 'sandbox',
          method: 'oauth2',
          credentials: {
            clientId: 'test-client',
            clientSecret: 'private-secret',
          },
        },
        verifier: 'test-verifier',
        redirectUri: 'http://localhost:5173/console/integrations/oauth',
        revision: 1,
      }),
      'org:admin:test-state',
    );
    const db = {
      one: jest.fn(async (sql: string) =>
        sql.startsWith('DELETE')
          ? { encrypted_payload: payload }
          : sql.includes('integration_providers')
            ? { revision: 1 }
            : { id: 'org' },
      ),
      transaction: jest.fn(),
    };
    const service = new OrganizationIntegrationsService(
      db as unknown as DbService,
    );
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json(
          { error: 'invalid_client', error_description: 'private-secret' },
          { status: 401 },
        ),
      );
    const error = await service
      .completeOAuth(actor, 'test-state', 'private-code')
      .catch((e) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toEqual({
      code: 'invalid_client',
      message: expect.stringContaining('client ID and client secret'),
    });
    expect(JSON.stringify(error.getResponse())).not.toContain('private-');
    expect(db.transaction).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
    else process.env.INTEGRATION_ENCRYPTION_KEY = previous;
  }
});
