import { OrganizationIntegrationsService } from '../src/modules/organization-integrations/organization-integrations.service';
import { DbService } from '../src/platform/database/db.service';
import { Actor, Role } from '../src/shared/actor';

describe('Google hosted authorization', () => {
  const original = { ...process.env };
  const actor = {
    tenantId: 'org',
    userId: 'admin',
    role: Role.HR_ADMIN,
  } as Actor;
  const tx = {
    one: jest.fn(async () => ({ revision: 1 })),
    query: jest.fn(async () => []),
  };
  const db = {
    one: jest.fn(async () => ({ id: 'org' })),
    query: jest.fn(async () => [
      { provider: 'google_calendar', enabled: true },
    ]),
    transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
  };
  const service = new OrganizationIntegrationsService(
    db as unknown as DbService,
  );
  beforeEach(() => {
    process.env.PUBLIC_WEB_BASE_URL = 'http://localhost:5173';
    process.env.NODE_ENV = 'test';
    process.env.INTEGRATION_ENCRYPTION_KEY = 'ab'.repeat(32);
    process.env.OAUTH_GOOGLE_CALENDAR_CLIENT_ID =
      'fixture.apps.googleusercontent.com';
    process.env.OAUTH_GOOGLE_CALENDAR_CLIENT_SECRET = 'fixture-secret';
  });
  afterEach(() => {
    process.env = { ...original };
  });

  it('requests account selection and consent with PKCE without exposing the app secret', async () => {
    const result = await service.startOAuth(actor, {
      provider: 'google_calendar',
      environment: 'sandbox',
      method: 'oauth2',
      credentials: {},
    });
    const url = new URL(result.authorizationUrl);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('prompt')).toBe('select_account consent');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'http://localhost:5173/console/integrations/oauth',
    );
    expect(result.authorizationUrl).not.toContain('fixture-secret');
  });
  it('reports missing credentials and refuses to launch an unregistered app', async () => {
    delete process.env.OAUTH_GOOGLE_CALENDAR_CLIENT_SECRET;
    const providers = await service.providers(actor);
    expect(
      providers.find((p) => p.provider === 'google_calendar')?.oauthReady,
    ).toBe(false);
    await expect(
      service.startOAuth(actor, {
        provider: 'google_calendar',
        environment: 'sandbox',
        method: 'oauth2',
        credentials: {},
      }),
    ).rejects.toThrow('configure the provider application');
  });
  it('does not advertise authorization readiness without a valid callback origin', async () => {
    delete process.env.PUBLIC_WEB_BASE_URL;
    const providers = await service.providers(actor);
    expect(
      providers.find((p) => p.provider === 'google_calendar')?.oauthReady,
    ).toBe(false);
  });
  it.each([undefined, 'invalid-key'])(
    'blocks authorization before writing state when encryption is %s',
    async (value) => {
      if (value === undefined) delete process.env.INTEGRATION_ENCRYPTION_KEY;
      else process.env.INTEGRATION_ENCRYPTION_KEY = value;
      const providers = await service.providers(actor);
      const google = providers.find((p) => p.provider === 'google_calendar');
      expect(google?.oauthReady).toBe(false);
      expect(google?.setupMessage).toContain('INTEGRATION_ENCRYPTION_KEY');
      await expect(
        service.startOAuth(actor, {
          provider: 'google_calendar',
          environment: 'sandbox',
          method: 'oauth2',
          credentials: {},
        }),
      ).rejects.toThrow('Integration encryption key is not configured');
      expect(tx.query).not.toHaveBeenCalled();
    },
  );
});
