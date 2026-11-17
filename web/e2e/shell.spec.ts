import { test, expect } from '@playwright/test';
import { roles, roleLabel, visibleNavigation } from '../src/permissions';
// Login throttle is real: give each role group time to avoid five/minute per-IP limit.
for (const [index, role] of roles.entries())
  test(`${role} session, navigation, forbidden and logout`, async ({
    page,
  }) => {
    if (index === 0 || index === 5) await page.waitForTimeout(61000);
    await page.goto('login');
    await page
      .getByLabel('Organization', { exact: true })
      .fill(role === 'SUPER_ADMIN' ? 'platform' : 'console-test');
    await page
      .getByLabel('Email', { exact: true })
      .fill(`${role.toLowerCase()}@console.test`);
    await page
      .getByLabel('Password', { exact: true })
      .fill(process.env.SEED_PASSWORD!);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(
      page.getByRole('heading', {
        level: 1,
        name:
          role === 'SUPER_ADMIN'
            ? 'Organizations'
            : `${roleLabel(role)} overview`,
      }),
    ).toBeVisible();
    for (const item of visibleNavigation(role)) {
      const nav = page.getByRole('navigation');
      if (item.built)
        await expect(
          nav.getByRole('link', { name: item.label, exact: true }),
        ).toBeVisible();
      else
        await expect(
          nav.getByRole('button', { name: new RegExp(item.label) }),
        ).toBeDisabled();
    }
    await page.reload();
    await expect(
      page.getByRole('heading', {
        level: 1,
        name:
          role === 'SUPER_ADMIN'
            ? 'Organizations'
            : `${roleLabel(role)} overview`,
      }),
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
  await page.getByLabel('Organization', { exact: true }).fill('console-test');
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

test('logout and account changes synchronize across open tabs', async ({
  page,
  context,
}) => {
  await page.waitForTimeout(61000);
  await page.goto('login');
  await page.getByLabel('Organization', { exact: true }).fill('platform');
  await page
    .getByLabel('Email', { exact: true })
    .fill('super_admin@console.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Organizations', exact: true }),
  ).toBeVisible();
  const other = await context.newPage();
  await other.goto('http://localhost:5173/console/home/super_admin');
  await expect(
    other.getByRole('heading', { name: 'Organizations', exact: true }),
  ).toBeVisible();
  await page.bringToFront();
  await page.locator('summary').click();
  await page.getByRole('button', { name: 'Sign out' }).click();
  for (const tab of [page, other]) {
    await expect(
      tab.getByRole('heading', { name: 'Sign in', exact: true }),
    ).toBeVisible();
    await expect(tab.locator('summary')).toHaveCount(0);
  }
  await page.getByLabel('Organization', { exact: true }).fill('console-test');
  await page.getByLabel('Email', { exact: true }).fill('employee@console.test');
  await page
    .getByLabel('Password', { exact: true })
    .fill(process.env.SEED_PASSWORD!);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  for (const tab of [page, other]) {
    await expect(tab.getByText('Employee overview')).toBeVisible();
    await expect(
      tab.getByRole('heading', { name: 'Organizations', exact: true }),
    ).toHaveCount(0);
    await expect(tab.getByRole('navigation').getByRole('button')).toHaveCount(
      0,
    );
  }
});
