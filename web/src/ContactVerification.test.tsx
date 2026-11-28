import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { ContactVerificationPage } from './ContactVerification';

afterEach(() => vi.unstubAllGlobals());

const token = `${'1'.repeat(8)}-1111-4111-8111-${'1'.repeat(12)}.${'a'.repeat(43)}`;
const open = (hash: string) =>
  render(
    <MemoryRouter initialEntries={[`/contact-verification${hash}`]}>
      <ContactVerificationPage />
    </MemoryRouter>,
  );

it('confirms the contact choices only when the candidate clicks', async () => {
  const fetcher = vi.fn(async () =>
    Response.json(
      {
        message:
          'If the verification was valid, your contact choices have been confirmed.',
      },
      { status: 202 },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  open(`#tenant=tes&token=${token}`);
  expect(
    screen.getByRole('heading', { name: 'Confirm your contact preferences' }),
  ).toBeVisible();
  expect(fetcher).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  expect(
    await screen.findByText(
      'If the verification was valid, your contact choices have been confirmed.',
    ),
  ).toBeVisible();
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('/api/v1/public/tes/contact-verification');
  expect(init.method).toBe('POST');
  expect(JSON.parse(String(init.body))).toEqual({ token });
});

it('explains an incomplete link', () => {
  open('#tenant=tes');
  expect(
    screen.getByRole('heading', { name: 'Link incomplete' }),
  ).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
});
