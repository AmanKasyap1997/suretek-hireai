import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, organization: string, email: string) {
  await page.goto('http://localhost:5173/console/login');
  await page.getByLabel('Organization', { exact: true }).fill(organization);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Toggle navigation' }),
  ).toBeVisible();
}
test('platform enables a provider and organization admin owns and disconnects its connection', async ({
  page,
  browser,
}) => {
  // Honor real login throttling after the other browser suites.
  await page.waitForTimeout(61000);
  await login(page, 'platform', 'super_admin@console.test');
  await page.goto('http://localhost:5173/console/super-admin/integrations');
  await page
    .getByRole('button', { name: 'Enable OpenAI', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Disable OpenAI', exact: true }),
  ).toBeVisible();
  const organization = await browser.newContext();
  const admin = await organization.newPage();
  try {
    await login(admin, 'console-test', 'hr_admin@console.test');
    await admin
      .getByRole('navigation')
      .getByRole('link', { name: 'Integrations', exact: true })
      .click();
    await admin.getByRole('button', { name: 'Connect OpenAI' }).click();
    await admin
      .getByLabel('API key', { exact: true })
      .fill('browser-fixture-secret-1234');
    await admin.getByRole('button', { name: 'Save connection' }).click();
    await expect(admin.getByText('Status: unverified')).toBeVisible();
    await expect(admin.getByLabel('API key', { exact: true })).toHaveValue('');
    const connections = await admin.request.get(
      'http://localhost:5173/api/v1/organization/integrations',
    );
    expect(connections.status()).toBe(200);
    const payload = await connections.text();
    expect(payload).not.toContain('browser-fixture-secret');
    expect(payload).toContain('****1234');
    await expect(
      admin.getByRole('button', { name: 'Enable connection', exact: true }),
    ).toBeDisabled();
    await admin.setViewportSize({ width: 360, height: 800 });
    expect(
      await admin.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    page.once('dialog', (d) => d.accept());
    await page
      .getByRole('button', { name: 'Disable OpenAI', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Enable OpenAI', exact: true }),
    ).toBeVisible();
    await admin.reload();
    await expect(
      admin.getByRole('button', { name: 'Connect OpenAI' }),
    ).toHaveCount(0);
    await expect(admin.getByText('Status: disabled')).toBeVisible();
    admin.once('dialog', (d) => d.accept());
    await admin
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await expect(
      admin.getByRole('button', { name: 'Disconnect', exact: true }),
    ).toBeDisabled();
  } finally {
    await organization.close();
  }
});
