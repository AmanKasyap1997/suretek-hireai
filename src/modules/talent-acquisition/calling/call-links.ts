import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { readConfig } from '../../../platform/config';

/**
 * Plivo reaches HireAI at unguessable per-call addresses: a token signs the
 * organization and call attempt, so a webhook or audio stream can't be
 * opened for a call it doesn't belong to.
 */
const key = () =>
  createHash('sha256')
    .update('hireai-call-links:' + readConfig().JWT_SECRET)
    .digest();

export function callToken(tenantId: string, attemptId: string) {
  return createHmac('sha256', key())
    .update(`${tenantId}:${attemptId}`)
    .digest('base64url');
}

export function callTokenValid(
  tenantId: string,
  attemptId: string,
  token: unknown,
) {
  if (typeof token !== 'string') return false;
  const expected = Buffer.from(callToken(tenantId, attemptId));
  const given = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The public origin Plivo calls back, or null when it isn't configured. */
export function publicApiOrigin() {
  const base = readConfig().PUBLIC_API_BASE_URL;
  return base ? new URL(base).origin : null;
}

export function callLinks(tenantId: string, attemptId: string) {
  const origin = publicApiOrigin();
  if (!origin) return null;
  const token = callToken(tenantId, attemptId);
  const path = `/api/v1/public/calls/plivo/${tenantId}/${attemptId}`;
  return {
    answerUrl: `${origin}${path}/answer?token=${token}`,
    hangupUrl: `${origin}${path}/hangup?token=${token}`,
    streamUrl: `${origin.replace(/^http/, 'ws')}/api/v1/public/calls/plivo/stream/${tenantId}/${attemptId}/${token}`,
  };
}
