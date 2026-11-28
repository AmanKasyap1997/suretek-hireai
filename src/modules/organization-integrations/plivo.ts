import { createHmac, timingSafeEqual } from 'node:crypto';
import { DbClient } from '../../platform/database/db.service';
import { decryptSecret } from '../super-admin/secrets';

export const PLIVO_API = 'https://api.plivo.com/v1';
export const E164 = /^\+[1-9][0-9]{7,14}$/;

/** An organization's Plivo account and the number calls come from. */
export interface PlivoCredentials {
  authId: string;
  authToken: string;
  phoneNumber: string;
}

export class PlivoError extends Error {
  constructor(
    /** auth: bad Auth ID/Token; rejected: Plivo refused the call; network. */
    readonly reason: 'auth' | 'rejected' | 'network',
    readonly status = 0,
  ) {
    super(`Plivo request failed: ${reason}${status ? ` (${status})` : ''}`);
  }
}

const authorization = (c: PlivoCredentials) =>
  'Basic ' + Buffer.from(`${c.authId}:${c.authToken}`).toString('base64');

const accountUrl = (c: PlivoCredentials, path = '') =>
  `${PLIVO_API}/Account/${encodeURIComponent(c.authId)}/${path}`;

async function plivoRequest(
  credentials: PlivoCredentials,
  path: string,
  init: { method: string; body?: unknown },
) {
  let response: Response;
  try {
    response = await fetch(accountUrl(credentials, path), {
      method: init.method,
      headers: {
        Authorization: authorization(credentials),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PlivoError('network');
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    throw new PlivoError('auth', response.status);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new PlivoError(
      response.status >= 500 ? 'network' : 'rejected',
      response.status,
    );
  }
  return response;
}

/** Places a call; Plivo then requests answerUrl when it's picked up. */
export async function plivoCall(
  credentials: PlivoCredentials,
  call: {
    to: string;
    answerUrl: string;
    hangupUrl: string;
    ringSeconds: number;
    maxSeconds: number;
  },
): Promise<string> {
  const response = await plivoRequest(credentials, 'Call/', {
    method: 'POST',
    body: {
      from: credentials.phoneNumber,
      to: call.to,
      answer_url: call.answerUrl,
      answer_method: 'POST',
      hangup_url: call.hangupUrl,
      hangup_method: 'POST',
      ring_timeout: call.ringSeconds,
      time_limit: call.maxSeconds,
    },
  });
  const data = (await response.json().catch(() => null)) as {
    request_uuid?: unknown;
  } | null;
  const id = data?.request_uuid;
  if (typeof id !== 'string' || !id || id.length > 100)
    throw new PlivoError('rejected', response.status);
  return id;
}

/**
 * Ends a call: the live call when its CallUUID is known, otherwise the
 * outbound request that is still ringing. Best effort.
 */
export async function plivoHangUp(
  credentials: PlivoCredentials,
  ids: { callId?: string | null; requestId?: string | null },
) {
  const path = ids.callId
    ? `Call/${encodeURIComponent(ids.callId)}/`
    : ids.requestId
      ? `Request/${encodeURIComponent(ids.requestId)}/`
      : null;
  if (!path) return;
  try {
    const response = await plivoRequest(credentials, path, {
      method: 'DELETE',
    });
    await response.body?.cancel();
  } catch {
    /* The call may already have ended. */
  }
}

/** True when the Auth ID/Token work and the number belongs to the account. */
export async function verifyPlivo(credentials: PlivoCredentials) {
  if (!E164.test(credentials.phoneNumber)) return false;
  try {
    (await plivoRequest(credentials, '', { method: 'GET' })).body?.cancel();
    const number = credentials.phoneNumber.slice(1);
    (
      await plivoRequest(credentials, `Number/${number}/`, { method: 'GET' })
    ).body?.cancel();
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks Plivo's X-Plivo-Signature-V3: HMAC-SHA256 (key: the Auth Token,
 * base64) of the URL, a ".", the POST parameters sorted by name and
 * concatenated as name+value, a ".", and the nonce. The header may hold
 * several comma-separated signatures (one per active token).
 */
export function plivoSignatureValid(input: {
  url: string;
  params: Record<string, unknown>;
  nonce: string | undefined;
  signatures: (string | undefined)[];
  authToken: string;
}) {
  if (!input.nonce) return false;
  const url = new URL(input.url);
  let base = `${url.protocol}//${url.host}${url.pathname}`;
  const query = [...url.searchParams.entries()]
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  if (query) base += `?${query}`;
  const params = Object.keys(input.params)
    .sort()
    .map((k) => {
      const v = input.params[k];
      return k + (Array.isArray(v) ? [...v].sort().join('') : String(v ?? ''));
    })
    .join('');
  const expected = createHmac('sha256', input.authToken)
    .update(`${base}.${params}.${input.nonce}`)
    .digest();
  return input.signatures
    .flatMap((header) => (header ?? '').split(','))
    .map((s) => Buffer.from(s.trim(), 'base64'))
    .some((s) => s.length === expected.length && timingSafeEqual(s, expected));
}

const xmlEscape = (v: string) =>
  v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Answer XML: stream the call's audio both ways over a WebSocket. */
export function plivoStreamXml(streamUrl: string, maxSeconds: number) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response><Stream bidirectional="true" keepCallAlive="true" contentType="audio/x-mulaw;rate=8000" streamTimeout="${maxSeconds + 60}">${xmlEscape(streamUrl)}</Stream></Response>`;
}

export const plivoHangupXml = `<?xml version="1.0" encoding="UTF-8"?>
<Response><Hangup/></Response>`;

export interface PhoneConnection {
  id: string;
  environment: 'production' | 'sandbox';
  credentials: PlivoCredentials | null;
}

/**
 * The organization's enabled Plivo connection (production preferred), with
 * its credentials, or null. Credentials are null when they can't be read.
 */
export async function plivoConnection(
  db: DbClient,
  tenantId: string,
): Promise<PhoneConnection | null> {
  const row = await db.one<{
    id: string;
    environment: 'production' | 'sandbox';
    encrypted_credentials: string;
  }>(
    `SELECT c.id,c.environment,c.encrypted_credentials
     FROM integration_configs c
     JOIN integration_providers p ON p.provider=c.provider AND p.enabled AND p.revision=c.provider_revision
     WHERE c.tenant_id=$1 AND c.organization_id=$1 AND c.provider='plivo'
       AND c.status='enabled' AND c.encrypted_credentials<>''
     ORDER BY (c.environment='production') DESC LIMIT 1`,
    [tenantId],
  );
  if (!row) return null;
  return {
    id: row.id,
    environment: row.environment,
    credentials: plivoCredentials(
      tenantId,
      row.environment,
      row.encrypted_credentials,
    ),
  };
}

/** Decrypts a stored Plivo connection's credentials, or null. */
export function plivoCredentials(
  tenantId: string,
  environment: string,
  encrypted: string,
): PlivoCredentials | null {
  try {
    const value: Record<string, unknown> = JSON.parse(
      decryptSecret(
        encrypted,
        ['organization', tenantId, 'plivo', environment].join(':'),
      ),
    );
    const { authId, authToken, phoneNumber } = value;
    return typeof authId === 'string' &&
      typeof authToken === 'string' &&
      typeof phoneNumber === 'string' &&
      E164.test(phoneNumber)
      ? { authId, authToken, phoneNumber }
      : null;
  } catch {
    return null;
  }
}
