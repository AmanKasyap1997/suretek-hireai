import { useState } from 'react';

const guides = {
  openai: {
    name: 'OpenAI',
    registration: 'https://developers.openai.com/siwc/request-client-id',
    documentation: 'https://developers.openai.com/siwc/website',
    steps: [
      {
        title: 'Confirm access and intended usage',
        description:
          'Request access to Sign in with ChatGPT for your commercial application. Confirm with OpenAI which authorization flow permits model usage in HireAI. Website identity sign-in alone does not grant API access.',
      },
      {
        title: 'Register the HireAI application',
        description:
          'Register your production and development callback URLs with OpenAI. Keep the issued client ID, approved scopes, token authentication method, and any server-side credentials for your deployment operator.',
      },
      {
        title: 'Complete the HireAI integration',
        description:
          'The deployment developer must implement the approved model-access flow, token validation, refresh, and connection verification. This build supports OpenAI API keys; its OpenAI authorization adapter is not implemented yet. Registration alone does not enable it.',
      },
    ],
  },
  anthropic: {
    name: 'Anthropic',
    registration:
      'https://platform.claude.com/docs/en/manage-claude/oauth-apps/organization-billing-connections',
    documentation:
      'https://platform.claude.com/docs/en/manage-claude/oauth-apps/oauth-reference',
    steps: [
      {
        title: 'Confirm organization billing eligibility',
        description:
          'Claude Platform OAuth links a customer’s API organization for billing. The customer must pay Anthropic directly for API usage. A Claude subscription alone does not qualify. Review the beta requirements and data handling before onboarding customers.',
      },
      {
        title: 'Register the HireAI application',
        description:
          'A Claude Console administrator creates an OAuth app with “Bill and link to organizations”, registers the callback URL, and configures an identity provider for client authentication. Anthropic uses signed client assertions rather than issuing a client secret. Follow the provider guide for operator credentials, customer user profiles, test users, and app review.',
      },
      {
        title: 'Complete the HireAI integration',
        description:
          'The deployment developer must implement pushed authorization requests, PKCE, signed client authentication, token refresh, and customer billing attribution. This build supports Anthropic API keys; its organization-linking adapter is not implemented yet. Registration alone does not enable it.',
      },
    ],
  },
};

export function AIProviderSetup({
  provider,
  platform = false,
}: {
  provider: string;
  platform?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  if (provider !== 'openai' && provider !== 'anthropic') return null;
  const guide = guides[provider];
  const current = guide.steps[step];
  return (
    <div className="authorization-setup">
      <p>Authorization window: setup required</p>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          setStep(0);
        }}
      >
        {open ? 'Hide' : 'View'} {guide.name} authorization setup
      </button>
      {open && (
        <section aria-label={`${guide.name} authorization setup`}>
          <h3>{guide.name} authorization setup</h3>
          <p>
            {platform
              ? 'The platform administrator and deployment developer complete this setup once for HireAI.'
              : 'Your platform administrator and deployment developer must complete this setup. You can connect with an API key now.'}
          </p>
          <p role="status">
            Step {step + 1} of {guide.steps.length}
          </p>
          <h4>{current.title}</h4>
          <p>{current.description}</p>
          {platform && step === 1 && (
            <p>
              Proposed callback path: <code>/console/integrations/oauth</code>.
              Use the deployed public web origin configured by your operator,
              and confirm the full URL with the developer before registration.
              Store provider credentials in the server secret manager.
            </p>
          )}
          <p>
            <a
              href={guide.registration}
              target="_blank"
              rel="noopener noreferrer"
            >
              {guide.name} registration guide
            </a>
            {' · '}
            <a
              href={guide.documentation}
              target="_blank"
              rel="noopener noreferrer"
            >
              Authorization documentation
            </a>
          </p>
          <div className="integration-actions">
            {step > 0 && (
              <button type="button" onClick={() => setStep(step - 1)}>
                Previous step
              </button>
            )}
            {step < guide.steps.length - 1 ? (
              <button type="button" onClick={() => setStep(step + 1)}>
                Next step
              </button>
            ) : (
              <button type="button" onClick={() => setOpen(false)}>
                Close setup guide
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
