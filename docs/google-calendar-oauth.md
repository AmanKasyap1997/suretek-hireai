# Google Calendar connection

An organization admin clicks **Authorize Google Calendar**, chooses a Google
account, and approves Calendar access. The callback saves and verifies the
connection automatically, then refreshes the original Integrations page. Popup
blocking falls back to navigation in the same tab. Existing sandbox verification
and production enablement rules still apply.

## One-time deployment setup

Logging into HireAI as admin does not register HireAI with Google. Its deployment
operator must configure the application credentials once:

1. Create/select a Google Cloud project and enable **Google Calendar API**.
2. Configure Google Auth Platform branding and audience. Add the Google accounts
   that will connect as test users while the application is in testing. Configure
   `https://www.googleapis.com/auth/calendar.events` and
   `https://www.googleapis.com/auth/calendar.calendarlist.readonly` scopes.
3. Create an OAuth client of type **Web application**. Register the exact redirect
   URI shown under Super Admin → Integrations → Google authorization setup.
   Locally, with `PUBLIC_WEB_BASE_URL=http://localhost:5173`, it is
   `http://localhost:5173/console/integrations/oauth`.
4. Set backend environment variables:

   ```dotenv
   PUBLIC_WEB_BASE_URL=http://localhost:5173
   OAUTH_GOOGLE_CALENDAR_CLIENT_ID=your-issued-client-id.apps.googleusercontent.com
   OAUTH_GOOGLE_CALENDAR_CLIENT_SECRET=your-issued-client-secret
   ```

   Use your HTTPS web origin in production. Keep secrets out of `web/.env*`,
   source control, and client bundles. Existing integration encryption must also
   be configured with `INTEGRATION_ENCRYPTION_KEY`.

5. Restart the backend, enable Google Calendar in Super Admin, then connect as an
   organization HR admin. Select the desired environment before authorization.

The application requests account selection, consent, offline access, and PKCE.
The callback exchanges the authorization code on the backend using one-time,
user-and-tenant-bound state. A successful exchange followed by a failed API check
is reported as connected but not verified. Retry verification from Integrations;
an exchange failure requires a fresh authorization attempt.

If Google reports `redirect_uri_mismatch`, compare the full registered URI with
the backend-derived URI, including scheme, host, port, and path. If access is
blocked during testing, check the configured test users and organization policy.
Review Google's verification requirements before publishing the OAuth app.

[Google's web-server OAuth documentation](https://developers.google.com/identity/protocols/oauth2/web-server)

## Returning from Google consent

The callback is a standalone, session-aware route. It captures `code` and `state`
in memory and removes them from the address bar. A temporary HireAI session-check
failure can be retried in the same window without losing those values or exchanging
the code twice. It still requires an organization HR administrator and the backend
checks the one-time state against the signed-in user and organization. Codes are
never saved in local/session storage.

If a session check fails, click **Try again** in that window. If your HireAI
session has expired, sign in and start **Authorize Google Calendar** again. A full
reload, copied callback URL or reopened callback cannot recover the cleared code;
start a new authorization. Only Google's `access_denied` response is labeled as
declined consent. Missing callback data and other provider failures have separate
messages. Do not share callback URLs, authorization codes, state values or client
secrets when reporting errors.

The session-error/remount regression is covered by the real application route-tree
tests and a browser test using a disposable callback and mocked provider exchange.
A live Google account consent/exchange still needs verification with your deployment's
OAuth client and redirect URI.
