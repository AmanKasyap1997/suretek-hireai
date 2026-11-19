import { test, expect } from '@playwright/test';

test('organization integrations expose LinkedIn Jobs without Company Pages', async ({
  page,
}) => {
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
    if (path.endsWith('/organization/integrations/providers'))
      return route.fulfill({
        json: [
          {
            provider: 'linkedin_jobs',
            label: 'LinkedIn Jobs',
            enabled: true,
            platformManaged: true,
            methods: ['oauth_client_credentials'],
            fields: { oauth_client_credentials: [] },
            setupMessage:
              'LinkedIn partner approval and organization onboarding are required.',
          },
        ],
      });
    return route.fulfill({ json: [] });
  });

  await page.goto('integrations');
  await expect(
    page.getByText('No published jobs are available yet.'),
  ).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'LinkedIn company pages' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: /Authorize LinkedIn/ }),
  ).toHaveCount(0);
});
