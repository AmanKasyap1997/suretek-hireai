import {
  verify,
  exchange,
} from '../src/modules/organization-integrations/provider-client';
import { connectionSchema } from '../src/modules/organization-integrations/catalog';
afterEach(() => {
  jest.restoreAllMocks();
  delete process.env.INTEGRATION_HRIS_VERIFY_URL;
  delete process.env.INTEGRATION_HRIS_TOKEN_URL;
});
it('uses the correct API key header without placing secrets in URLs', async () => {
  const mock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(new Response('{}', { status: 200 }));
  await expect(
    verify('openai', 'api_key', { apiKey: 'secret-key' }),
  ).resolves.toMatchObject({ ok: true });
  expect(mock).toHaveBeenCalledWith(
    'https://api.openai.com/v1/models',
    expect.objectContaining({
      headers: { Authorization: 'Bearer secret-key' },
      redirect: 'error',
    }),
  );
  mock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await verify('anthropic', 'api_key', { apiKey: 'anthropic-secret' });
  expect(mock).toHaveBeenLastCalledWith(
    'https://api.anthropic.com/v1/models',
    expect.objectContaining({
      headers: {
        'x-api-key': 'anthropic-secret',
        'anthropic-version': '2023-06-01',
      },
    }),
  );
});
it('exchanges refresh tokens and retains rotated refresh credentials', async () => {
  const mock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({
        access_token: 'new-access',
        refresh_token: 'rotated-refresh',
      }),
    )
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  const result = await verify('google_calendar', 'oauth_refresh_token', {
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'old-refresh',
  });
  expect(result).toMatchObject({
    ok: true,
    credentials: { refreshToken: 'rotated-refresh', accessToken: 'new-access' },
  });
  expect(mock.mock.calls[0][0]).toBe('https://oauth2.googleapis.com/token');
  expect(String(mock.mock.calls[0][1]?.body)).toContain(
    'grant_type=refresh_token',
  );
});
it('requires operator endpoints and supports client credentials and basic authentication', async () => {
  const mock = jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(Response.json({ access_token: 'client-token' }))
    .mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await expect(
    verify('hris', 'basic', { username: 'u', password: 'p' }),
  ).rejects.toThrow('configure');
  expect(mock).not.toHaveBeenCalled();
  process.env.INTEGRATION_HRIS_VERIFY_URL = 'https://hris.example.test/verify';
  process.env.INTEGRATION_HRIS_TOKEN_URL = 'https://hris.example.test/token';
  await expect(
    verify('hris', 'oauth_client_credentials', {
      clientId: 'id',
      clientSecret: 'secret',
      scope: 'read',
    }),
  ).resolves.toMatchObject({ ok: true });
  expect(String(mock.mock.calls[0][1]?.body)).toContain(
    'grant_type=client_credentials',
  );
  mock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
  await verify('hris', 'basic', { username: 'u', password: 'p' });
  expect(mock).toHaveBeenLastCalledWith(
    'https://hris.example.test/verify',
    expect.objectContaining({ headers: { Authorization: 'Basic dTpw' } }),
  );
});
it('rejects token failures, unsupported methods and injected credential fields', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValue(Response.json({ error: 'denied' }, { status: 401 }));
  await expect(
    exchange('google_calendar', new URLSearchParams()),
  ).rejects.toThrow('authentication failed');
  expect(
    connectionSchema.safeParse({
      provider: 'openai',
      environment: 'sandbox',
      method: 'smtp',
      credentials: { username: 'u', password: 'p' },
    }).success,
  ).toBe(false);
  expect(
    connectionSchema.safeParse({
      provider: 'openai',
      environment: 'sandbox',
      method: 'api_key',
      credentials: { apiKey: 'key', endpoint: 'https://elsewhere' },
    }).success,
  ).toBe(false);
});
it('retains rotated tokens when the verification network request fails', async () => {
  jest
    .spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(
      Response.json({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
      }),
    )
    .mockRejectedValueOnce(new Error('Network unavailable'));
  await expect(
    verify('microsoft_calendar', 'oauth_refresh_token', {
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'old-refresh',
    }),
  ).resolves.toMatchObject({
    ok: false,
    credentials: { refreshToken: 'new-refresh' },
  });
});
it('verifies SMTP with required TLS and closes the transport', async () => {
  const nodemailer = await import('nodemailer');
  const close = jest.fn(),
    check = jest.fn().mockResolvedValue(true);
  const transport = jest
    .spyOn(nodemailer.default, 'createTransport')
    .mockReturnValue({ verify: check, close } as unknown as ReturnType<
      typeof nodemailer.default.createTransport
    >);
  process.env.INTEGRATION_EMAIL_SMTP_HOST = 'smtp.example.test';
  process.env.INTEGRATION_EMAIL_SMTP_PORT = '587';
  try {
    await expect(
      verify('email', 'smtp', {
        username: 'organization',
        password: 'smtp-password',
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.example.test',
        port: 587,
        secure: false,
        requireTLS: true,
        tls: { rejectUnauthorized: true },
        auth: { user: 'organization', pass: 'smtp-password' },
      }),
    );
    expect(check).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    delete process.env.INTEGRATION_EMAIL_SMTP_HOST;
    delete process.env.INTEGRATION_EMAIL_SMTP_PORT;
  }
});
