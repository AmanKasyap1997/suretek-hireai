import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from '@playwright/test';
import { randomUUID } from 'node:crypto';
const mailbox = process.env.MAILPIT_URL ?? 'http://localhost:8025';
async function invitation(request: APIRequestContext, email: string) {
  let id: string | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`${mailbox}/api/v1/messages`);
        const data = (await response.json()) as {
          messages: { ID: string; To: { Address: string }[] }[];
        };
        id = data.messages.find((m) =>
          m.To.some((to) => to.Address === email),
        )?.ID;
        return Boolean(id);
      },
      {
        timeout: 15000,
        message: 'An invitation should reach the local test mailbox',
      },
    )
    .toBe(true);
  const message = (await (
    await request.get(`${mailbox}/api/v1/message/${id}`)
  ).json()) as { Text: string };
  const link = message.Text.match(
    /https?:\/\/[^\s]+\/console\/accept-invitation#[^\s]+/,
  )?.[0];
  if (!link)
    throw new Error('Invitation email did not contain an acceptance link');
  if (new URL(link).search || link.includes(email))
    throw new Error(
      'Invitation link contains unexpected query or identity data',
    );
  return link;
}
async function acceptAndLogin(
  page: Page,
  link: string,
  organization: string,
  email: string,
  password: string,
) {
  await page.goto(link).catch(() => {
    throw new Error('Could not open the invitation page');
  });
  await expect(
    page.getByRole('heading', { name: 'Accept your invitation' }),
  ).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe('');
  await page.getByLabel('Create password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page
    .getByRole('button', { name: 'Accept invitation & set password' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Invitation accepted' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Continue to sign in' }).click();
  await expect(page.getByLabel('Organization', { exact: true })).toHaveValue(
    organization,
  );
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('platform creates organization; emailed admin and staff invitations activate scoped accounts', async ({
  page,
  context,
  browser,
}) => {
  const key = `e2e-${randomUUID()}`,
    orgName = `Organization ${key}`;
  const adminEmail = `admin-${key}@console.test`,
    password = process.env.SEED_PASSWORD!;
  await page.goto('login');
  await page.getByLabel('Organization', { exact: true }).fill('platform');
  await page
    .getByLabel('Email', { exact: true })
    .fill('super_admin@console.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Platform dashboard', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation').getByText('Jobs', { exact: true }),
  ).toHaveCount(0);
  expect(
    (await context.request.get('http://localhost:3000/api/v1/jobs')).status(),
  ).toBe(403);
  await page.getByRole('link',{name:'Organizations',exact:true}).click();
  await page.getByText('Add organization',{exact:true}).click();
  await page.getByLabel('Name', { exact: true }).fill(orgName);
  await page.getByLabel('Slug', { exact: true }).fill(key);
  await page
    .getByLabel('First HR Admin name', { exact: true })
    .fill('Invited organization admin');
  await page.getByLabel('First HR Admin email', { exact: true }).fill(adminEmail);
  await page
    .getByRole('button', { name: 'Create organization & invite admin' })
    .click();
  await expect(
    page.getByText('Saved successfully.'),
  ).toBeVisible();
  const adminLink = await invitation(context.request, adminEmail);
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  try {
    await acceptAndLogin(admin, adminLink, key, adminEmail, password);
    await expect(
      admin.getByRole('heading', { name: 'Organization Admin overview' }),
    ).toBeVisible();
    await admin
      .getByRole('navigation')
      .getByRole('link', { name: 'Team & invitations' })
      .click();
    await expect(
      admin.getByRole('heading', { name: 'Team & invitations' }),
    ).toBeVisible();
    await expect(
      admin.getByRole('option', { name: 'Super Admin', exact: true }),
    ).toHaveCount(0);
    await expect(
      admin.getByRole('option', { name: 'Organization Admin', exact: true }),
    ).toHaveCount(0);
    for (const [role, label] of [
      ['RECRUITER', 'Recruiter'],
      ['HIRING_MANAGER', 'Hiring Manager'],
      ['INTERVIEWER', 'Interviewer'],
    ]) {
      const email = `${role.toLowerCase()}-${key}@console.test`;
      await admin
        .getByLabel('Full name', { exact: true })
        .fill(`Invited ${label}`);
      await admin.getByLabel('Email', { exact: true }).fill(email);
      await admin.getByLabel('Role', { exact: true }).selectOption(role);
      await admin
        .getByRole('button', { name: 'Send invitation', exact: true })
        .click();
      await expect(
        admin.getByText(
          'Invitation emailed. The account becomes active after acceptance.',
        ),
      ).toBeVisible();
      const link = await invitation(adminContext.request, email);
      const staffContext = await browser.newContext(),
        staff = await staffContext.newPage();
      try {
        await acceptAndLogin(staff, link, key, email, password);
        await expect(
          staff.getByRole('heading', { name: `${label} overview` }),
        ).toBeVisible();
        expect(
          (
            await staffContext.request.get(
              'http://localhost:3000/api/v1/saas/users',
            )
          ).status(),
        ).toBe(403);
        await staff.goto('http://localhost:5173/console/organizations');
        await expect(
          staff.getByRole('heading', { name: 'Not authorized' }),
        ).toBeVisible();
        if (role === 'RECRUITER') {
          await admin
            .getByRole('button', { name: 'Refresh team', exact: true })
            .click();
          await admin
            .getByRole('button', {
              name: `Deactivate for Invited ${label}`,
              exact: true,
            })
            .click();
          await expect(
            admin.getByText('Account status updated.'),
          ).toBeVisible();
          expect(
            (
              await staffContext.request.get(
                'http://localhost:3000/api/v1/auth/session',
              )
            ).status(),
          ).toBe(401);
        }
      } finally {
        await staffContext.close();
      }
    }
  } finally {
    await adminContext.close();
  }
});
