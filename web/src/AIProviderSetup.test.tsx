import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AIProviderSetup } from './AIProviderSetup';

it.each(['openai', 'anthropic'])(
  'guides %s setup without claiming authorization is active',
  async (provider) => {
    render(<AIProviderSetup provider={provider} platform />);
    await userEvent.click(
      screen.getByRole('button', { name: /View .* authorization setup/ }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Step 1 of 3');
    expect(
      screen.getByRole('link', { name: /registration guide/ }),
    ).toHaveAttribute('href', expect.stringMatching(/^https:\/\//));
    await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText('/console/integrations/oauth')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
    expect(screen.getByText(/adapter is not implemented yet/)).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /Enable|Authorize|Connect/ }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Previous step' }),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Step 2 of 3');
  },
);

it('directs organization admins to platform setup and keeps API keys available', async () => {
  render(<AIProviderSetup provider="openai" />);
  await userEvent.click(screen.getByRole('button', { name: /View OpenAI/ }));
  expect(screen.getByText(/You can connect with an API key now/)).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
  expect(
    screen.queryByText('/console/integrations/oauth'),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Next step' }));
  await userEvent.click(
    screen.getByRole('button', { name: 'Close setup guide' }),
  );
  expect(screen.queryByRole('region')).not.toBeInTheDocument();
});
