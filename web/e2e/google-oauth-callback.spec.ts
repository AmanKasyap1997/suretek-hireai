import { test, expect, type Route } from '@playwright/test';

test('Google callback survives a session error after clearing its URL without replaying the code', async ({
  page,
}) => {
  let failSession = false;
  let completion: Route | undefined;
  let exchanges = 0;
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/auth/session'))
      return route.fulfill({
        status: failSession ? 503 : 200,
        json: failSession
          ? { message: 'Session temporarily unavailable' }
          : {
              user: {
                id: 'admin',
                tenant_id: 'org',
                full_name: 'Test admin',
                email: 'admin@example.test',
                role: 'HR_ADMIN',
                active: true,
              },
              expiresAt: Date.now() + 900000,
            },
      });
    if (path.endsWith('/oauth/complete')) {
      exchanges++;
      expect(route.request().postDataJSON()).toEqual({
        code: 'disposable-code',
        state: 'disposable-state',
      });
      completion = route;
      return;
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(
    'integrations/oauth?code=disposable-code&state=disposable-state&scope=calendar',
  );
  await expect.poll(() => exchanges).toBe(1);
  await expect(page).toHaveURL(/\/console\/integrations\/oauth$/);
  failSession = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('heading', { name: 'Unable to load your session' }),
  ).toBeVisible();
  failSession = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await completion!.fulfill({ json: { id: 'connection' } });
  await expect(page.getByText(/Connected and verified/)).toBeVisible();
  expect(exchanges).toBe(1);
  expect(
    await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
    })),
  ).toEqual({ local: [], session: [] });
});
