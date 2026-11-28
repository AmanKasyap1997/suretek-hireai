import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api, ApiError } from './api';
import { Brand } from './Brand';

/**
 * The link in a candidate's "Verify your contact preferences" email. The
 * candidate confirms with a click (so email scanners that open links can't
 * confirm for them), which verifies the call, recording and transcription
 * choices they made when applying.
 */
export function ContactVerificationPage() {
  const location = useLocation();
  // Read once: the fragment is removed from the address bar below.
  const [link] = useState(() => {
    const params = new URLSearchParams(location.hash.slice(1));
    return {
      tenant: params.get('tenant') ?? '',
      token: params.get('token') ?? '',
    };
  });
  const [state, setState] = useState<'ready' | 'sending' | 'done'>('ready');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    // Fragments never reach servers; also keep the token out of history.
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname + window.location.search,
    );
  }, []);
  const complete = /^[a-z0-9-]{1,80}$/.test(link.tenant) && !!link.token;

  async function confirm() {
    setState('sending');
    setError('');
    try {
      const result = await api<{ message: string }>(
        `/public/${encodeURIComponent(link.tenant)}/contact-verification`,
        { method: 'POST', body: JSON.stringify({ token: link.token }) },
        true,
      );
      setMessage(result.message);
      setState('done');
    } catch (reason) {
      setState('ready');
      setError(
        reason instanceof ApiError && reason.status === 429
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : reason instanceof ApiError && reason.status === 400
            ? 'This link is incomplete. Open the latest email from us and use its link.'
            : 'We couldn’t confirm right now. Please try again.',
      );
    }
  }

  return (
    <main className="invitation-page">
      <header className="login-header">
        <Brand />
      </header>
      <section className="invitation-panel">
        {!complete ? (
          <>
            <h1>Link incomplete</h1>
            <p>
              Open the latest “Verify your contact preferences” email and use
              its link.
            </p>
          </>
        ) : state === 'done' ? (
          <>
            <p className="eyebrow">THANK YOU</p>
            <h1>Contact preferences</h1>
            <p role="status">{message}</p>
            <p className="muted">
              If the link had expired or was already used, apply again from the
              job page to get a new one. You can close this page.
            </p>
          </>
        ) : (
          <>
            <p className="eyebrow">YOUR APPLICATION</p>
            <h1>Confirm your contact preferences</h1>
            <p>
              Confirm that you applied and that the contact choices you made on
              the application form are yours: whether the hiring team may call
              you, and whether a call may be recorded or transcribed.
            </p>
            <p className="muted">
              You can withdraw these choices at any time by contacting the
              organization you applied to.
            </p>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <button
              type="button"
              className="primary"
              disabled={state === 'sending'}
              onClick={() => void confirm()}
            >
              {state === 'sending' ? 'Confirming…' : 'Confirm'}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
