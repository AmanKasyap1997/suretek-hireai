import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth, type Session } from './auth';

const makeSession = (): Session => ({
  user: {
    id: 'admin',
    tenant_id: 'tenant',
    full_name: 'Admin person',
    email: 'admin@console.test',
    role: 'SUPER_ADMIN',
    active: true,
  },
  expiresAt: Date.now() + 900000,
});
const employee = (): Session => ({
  ...makeSession(),
  user: {
    ...makeSession().user,
    id: 'employee',
    full_name: 'Employee person',
    role: 'EMPLOYEE',
  },
});

class TabChannel {
  static peers = new Set<TabChannel>();
  static messages: unknown[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    TabChannel.peers.add(this);
  }
  postMessage(data: unknown) {
    TabChannel.messages.push(data);
    for (const peer of TabChannel.peers)
      if (peer !== this && peer.name === this.name) peer.onmessage?.({ data });
  }
  close() {
    TabChannel.peers.delete(this);
  }
}

let serverSession: Session | null;
function sessionResponse() {
  return new Response(JSON.stringify(serverSession ?? {}), {
    status: serverSession ? 200 : 401,
  });
}
beforeEach(() => {
  serverSession = makeSession();
  TabChannel.peers.clear();
  TabChannel.messages = [];
  vi.stubGlobal('BroadcastChannel', TabChannel);
  vi.stubEnv('VITE_TENANT_ID', '10000000-0000-4000-8000-000000000001');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'DELETE') {
        serverSession = null;
        return new Response(null, { status: 204 });
      }
      if (init.method === 'POST') {
        serverSession = employee();
        return new Response('{}', { status: 200 });
      }
      return sessionResponse();
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function Probe() {
  const auth = useAuth();
  return (
    <>
      <p>{auth.status}</p>
      <p>{auth.session?.user.full_name ?? 'Signed out'}</p>
      <p>{auth.session?.user.role}</p>
      <p>{auth.logoutError}</p>
      <button onClick={() => void auth.logout()}>Sign out</button>
      <button
        onClick={() => void auth.login('employee@console.test', 'secret')}
      >
        Sign in
      </button>
    </>
  );
}
async function openTab() {
  const cache = new QueryClient();
  const view = render(
    <QueryClientProvider client={cache}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
  await within(view.container).findByText('Admin person');
  cache.setQueryData(['private'], 'Admin private data');
  return { cache, view, tab: within(view.container) };
}

it.each(['focus', 'pageshow'])(
  'removes a session deleted in another tab on %s, without BroadcastChannel',
  async (event) => {
    vi.stubGlobal('BroadcastChannel', undefined);
    const { cache } = await openTab();
    serverSession = null;
    await act(async () => window.dispatchEvent(new Event(event)));
    await screen.findByText('Signed out');
    expect(screen.queryByText('Admin person')).toBeNull();
    expect(cache.getQueryData(['private'])).toBeUndefined();
  },
);

it.each(['account', 'role', 'tenant'])(
  'clears private cache when the %s changes on return to the tab',
  async (change) => {
    const { cache } = await openTab();
    serverSession = employee();
    if (change === 'role') serverSession.user.id = 'admin';
    if (change === 'tenant')
      serverSession.user = {
        ...makeSession().user,
        tenant_id: 'other-tenant',
        full_name: 'Employee person',
      };
    await act(async () => window.dispatchEvent(new Event('focus')));
    await screen.findByText('Employee person');
    expect(screen.queryByText('Admin person')).toBeNull();
    expect(cache.getQueryData(['private'])).toBeUndefined();
  },
);

it('keeps cache for the same identity during revalidation', async () => {
  const { cache } = await openTab();
  await act(async () => window.dispatchEvent(new Event('focus')));
  await screen.findByText('ready');
  expect(cache.getQueryData(['private'])).toBe('Admin private data');
});

it('synchronizes logout and subsequent login between two open tabs', async () => {
  const first = await openTab();
  const second = await openTab();
  await userEvent.click(first.tab.getByRole('button', { name: 'Sign out' }));
  await first.tab.findByText('Signed out');
  await second.tab.findByText('Signed out');
  expect(first.cache.getQueryData(['private'])).toBeUndefined();
  expect(second.cache.getQueryData(['private'])).toBeUndefined();
  await userEvent.click(first.tab.getByRole('button', { name: 'Sign in' }));
  await first.tab.findByText('Employee person');
  await second.tab.findByText('Employee person');
  expect(second.tab.getByText('EMPLOYEE')).toBeVisible();
  expect(TabChannel.messages).toEqual(['signed-out', 'session-changed']);
  first.view.unmount();
  second.view.unmount();
  expect(TabChannel.peers.size).toBe(0);
});

it('does not restore a logged-out session from an in-flight revalidation', async () => {
  const { tab } = await openTab();
  let finish!: (response: Response) => void;
  const stale = sessionResponse();
  vi.mocked(fetch).mockImplementationOnce(
    () => new Promise<Response>((resolve) => (finish = resolve)),
  );
  await act(async () => window.dispatchEvent(new Event('focus')));
  await userEvent.click(tab.getByRole('button', { name: 'Sign out' }));
  await act(async () => finish(stale));
  expect(tab.getByText('Signed out')).toBeVisible();
  expect(tab.queryByText('Admin person')).toBeNull();
});

it('does not silently sign back in after server logout fails', async () => {
  const { tab } = await openTab();
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Offline'));
  await userEvent.click(tab.getByRole('button', { name: 'Sign out' }));
  await tab.findByText(/Server sign-out could not be confirmed/);
  const calls = vi.mocked(fetch).mock.calls.length;
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(tab.getByText('Signed out')).toBeVisible();
  expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
});

it('removes stale user data when revalidation cannot reach the server', async () => {
  const { cache } = await openTab();
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Offline'));
  await act(async () => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(screen.getByText('error')).toBeVisible());
  expect(screen.queryByText('Admin person')).toBeNull();
  expect(cache.getQueryData(['private'])).toBeUndefined();
});
