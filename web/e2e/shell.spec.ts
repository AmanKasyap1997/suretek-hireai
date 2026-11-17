import { test, expect } from '@playwright/test';
import { roles, roleLabel, visibleNavigation } from '../src/permissions';
// Login throttle is real: give each role group time to avoid five/minute per-IP limit.
for (const [index, role] of roles.entries())
  test(`${role} session, navigation, forbidden and logout`, async ({
    page,
  }) => {
    if (index === 5) await page.waitForTimeout(61000);
    await page.goto('login');
    await page
      .getByLabel('Email', { exact: true })
      .fill(`${role.toLowerCase()}@console.test`);
    await page
      .getByLabel('Password', { exact: true })
      .fill(process.env.SEED_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: `${roleLabel(role)} overview` }),
    ).toBeVisible();
    for (const item of visibleNavigation(role))
      await expect(
        page
          .getByRole('navigation')
          .getByRole('button', { name: new RegExp(item.label) }),
      ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: `${roleLabel(role)} overview` }),
    ).toBeVisible();
    await page.goto(
      `home/${role === 'SUPER_ADMIN' ? 'employee' : 'super_admin'}`,
    );
    await expect(
      page.getByRole('heading', { name: 'Not permitted' }),
    ).toBeVisible();
    await page.locator('summary').click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(
      page.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(
      page.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });
test('session expiry removes protected content', async ({ page }) => {
  await page.waitForTimeout(61000);
  await page.goto('login');
  await page.getByLabel('Email', { exact: true }).fill('employee@console.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('Employee overview')).toBeVisible();
  await expect(
    page.getByText('Your session expired. Sign in again to continue.'),
  ).toBeVisible({ timeout: 65000 });
});
