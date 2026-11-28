import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HiringTeamDialog } from './HiringTeam';

let team: Record<string, unknown>[];
let calls: { url: string; method: string; body: unknown }[];
beforeEach(() => {
  calls = [];
  team = [
    {
      id: 'a1',
      user_id: 'u-hm',
      role: 'HIRING_MANAGER',
      full_name: 'Meera Manager',
      email: 'meera@example.com',
      active: true,
    },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      const method = init.method ?? 'GET';
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, method, body });
      if (url === '/api/v1/jobs/job-1/assignments' && method === 'GET')
        return Response.json(team);
      if (url === '/api/v1/jobs/job-1/assignments' && method === 'POST') {
        team = [
          ...team,
          {
            id: 'a2',
            user_id: body.userId,
            role: body.role,
            full_name: 'Ivan Interviewer',
            email: 'ivan@example.com',
            active: true,
          },
        ];
        return Response.json({ id: 'a2' }, { status: 201 });
      }
      if (url === '/api/v1/jobs/job-1/assignments/a1' && method === 'DELETE') {
        team = team.filter((m) => m.id !== 'a1');
        return Response.json({ id: 'a1' });
      }
      if (url === '/api/v1/interviews/panelists')
        return Response.json({
          data: [
            { id: 'u-admin', full_name: 'Asha Admin', role: 'HR_ADMIN' },
            { id: 'u-hm', full_name: 'Meera Manager', role: 'HIRING_MANAGER' },
            { id: 'u-int', full_name: 'Ivan Interviewer', role: 'INTERVIEWER' },
          ],
        });
      return Response.json({}, { status: 404 });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderDialog(canEdit: boolean) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <HiringTeamDialog
          job={{ id: 'job-1', title: 'PHP Developer' }}
          canEdit={canEdit}
          onClose={() => undefined}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it('lets an HR Admin add an interviewer and remove a hiring manager', async () => {
  const user = userEvent.setup();
  renderDialog(true);
  const list = await screen.findByRole('list', { name: 'Hiring team' });
  expect(within(list).getByText('Meera Manager')).toBeVisible();
  expect(
    within(list).getByText('Hiring manager · meera@example.com'),
  ).toBeVisible();
  const select = screen.getByLabelText('Add a hiring manager or interviewer');
  // Admins aren't added, and Meera is on the team already.
  await waitFor(() =>
    expect(
      within(select)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Choose someone', 'Ivan Interviewer · Interviewer']),
  );
  await user.selectOptions(select, 'u-int');
  await user.click(screen.getByRole('button', { name: 'Add to team' }));
  expect(
    await screen.findByText(
      'Ivan Interviewer can now see PHP Developer’s applicants.',
    ),
  ).toBeVisible();
  expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
    userId: 'u-int',
    role: 'INTERVIEWER',
  });
  await user.click(
    await screen.findByRole('button', { name: 'Remove Meera Manager' }),
  );
  expect(
    await screen.findByText('Meera Manager was taken off the hiring team.'),
  ).toBeVisible();
});

it('shows recruiters the team without changing it', async () => {
  renderDialog(false);
  expect(await screen.findByText('Meera Manager')).toBeVisible();
  expect(
    screen.getByText('An HR Admin changes the hiring team.'),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: /Remove/ })).toBeNull();
  expect(calls.some((c) => c.url.endsWith('/panelists'))).toBe(false);
});
