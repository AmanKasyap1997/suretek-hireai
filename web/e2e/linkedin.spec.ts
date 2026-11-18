import { test, expect } from '@playwright/test';
test('hosted LinkedIn consent opens a provider window without requesting app secrets', async ({
  page,
  context,
}) => {
  let submitted: unknown;
  await context.route('https://www.linkedin.com/oauth/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<h1>Provider authorization test</h1>',
    }),
  );
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/session'))
      return route.fulfill({
        json: {
          user: {
            id: 'admin',
            tenant_id: 'org',
            role: 'HR_ADMIN',
            full_name: 'Admin',
            email: 'admin@example.test',
            active: true,
            enabled_modules: ['hiring'],
          },
          expiresAt: Date.now() + 900000,
        },
      });
    if (path.endsWith('/providers'))
      return route.fulfill({
        json: [
          {
            provider: 'linkedin',
            label: 'LinkedIn company pages',
            enabled: true,
            methods: ['oauth2'],
            fields: { oauth2: [] },
            hostedOAuth: true,
            oauthReady: true,
          },
        ],
      });
    if (path.endsWith('/oauth/start')) {
      submitted = route.request().postDataJSON();
      return route.fulfill({
        json: {
          authorizationUrl:
            'https://www.linkedin.com/oauth/v2/authorization?client_id=platform-app&state=test-state',
        },
      });
    }
    if (path.endsWith('/pages'))
      return route.fulfill({ json: { pages: [], nextStart: null } });
    return route.fulfill({ json: [] });
  });
  await page.goto('integrations');
  await page
    .getByRole('button', {
      name: 'Connect LinkedIn company pages',
      exact: true,
    })
    .click();
  await expect(page.getByLabel('Client secret')).toHaveCount(0);
  await expect(page.getByLabel('Client ID')).toHaveCount(0);
  const opened = context.waitForEvent('page');
  await page
    .getByRole('button', { name: 'Connect with LinkedIn company pages' })
    .click();
  const popup = await opened;
  await expect(popup.getByRole('heading')).toHaveText(
    'Provider authorization test',
  );
  expect(submitted).toEqual({
    provider: 'linkedin',
    environment: 'sandbox',
    method: 'oauth2',
    credentials: {},
  });
  await expect(page).toHaveURL(/\/integrations$/);
  await popup.close();
});
