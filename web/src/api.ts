export class ApiError extends Error {
  constructor(
    public status: number,
    message = 'Request failed. Please check the values and try again.',
  ) {
    super(message);
  }
}
let unauthorized = () => {};
export function onUnauthorized(handler: () => void) {
  unauthorized = handler;
  return () => {
    unauthorized = () => {};
  };
}
export async function api<T>(
  path: string,
  init: RequestInit = {},
  ignore401 = false,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...init.headers },
    });
  } catch {
    throw new ApiError(0);
  }
  if (!response.ok) {
    if (response.status === 401 && !ignore401) unauthorized();
    const payload = await response.json().catch(() => null);
    const detail = Array.isArray(payload?.errors)
      ? payload.errors
          .map(
            (e: { path: string; message: string }) => e.path + ': ' + e.message,
          )
          .join('; ')
      : payload?.message;
    throw new ApiError(
      response.status,
      typeof detail === 'string' ? detail : undefined,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
export function loginError(error: unknown) {
  const status = error instanceof ApiError ? error.status : 0;
  return status === 401
    ? 'Email or password is incorrect.'
    : status === 423
      ? 'Your organization is suspended. Contact your administrator.'
      : status === 429
        ? 'Too many attempts. Wait one minute and try again.'
        : status === 403
          ? 'Sign-in is not permitted from this address. Contact your administrator.'
          : status === 0
            ? 'Cannot reach the server. Check your connection and try again.'
            : 'Sign-in is temporarily unavailable. Please try again.';
}
