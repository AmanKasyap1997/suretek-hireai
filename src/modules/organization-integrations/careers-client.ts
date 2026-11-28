import { Method } from './catalog';
import { effectiveCredentials } from './hosted-oauth';
import { providerAuth, trustedUrl } from './provider-client';

/** The job document sent to an organization's careers website. */
export interface CareersPosting {
  event: 'job.published';
  /** Stable per job: the website must create or update the job by this key. */
  externalId: string;
  organization: string;
  job: {
    id: string;
    title: string;
    description: string;
    department: string;
    location: string;
    employmentType: string;
    openings: number;
    salary: { min: number | null; max: number | null; currency: 'INR' } | null;
    publishedAt: string;
  };
}

export interface CareersDelivery {
  status: 'PUBLISHED' | 'FAILED' | 'UNKNOWN';
  remoteId: string | null;
  remoteUrl: string | null;
  errorCode: string | null;
  /** Credentials after any token exchange, to persist when they changed. */
  credentials: Record<string, string>;
}

/** Operator-owned endpoint: never accepted from the browser (prevents SSRF). */
export function careersPublishUrl() {
  return trustedUrl(process.env.INTEGRATION_CAREERS_CMS_PUBLISH_URL);
}

export function careersPublishConfigured() {
  try {
    careersPublishUrl();
    return true;
  } catch {
    return false;
  }
}

function publicUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

/**
 * Sends a published job to the careers website. The request is an upsert keyed
 * by externalId (also sent as Idempotency-Key), so resending it is safe.
 */
export async function publishCareersJob(
  method: Method,
  stored: Record<string, string>,
  posting: CareersPosting,
): Promise<CareersDelivery> {
  const endpoint = careersPublishUrl();
  let auth: Awaited<ReturnType<typeof providerAuth>>;
  try {
    auth = await providerAuth(
      'careers_cms',
      method,
      effectiveCredentials('careers_cms', stored),
    );
  } catch {
    // Nothing was sent to the website, so a later attempt is safe.
    return {
      status: 'FAILED',
      remoteId: null,
      remoteUrl: null,
      errorCode: 'CAREERS_AUTH_FAILED',
      credentials: stored,
    };
  }
  const credentials = auth.credentials;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...auth.headers,
        'Content-Type': 'application/json',
        'Idempotency-Key': posting.externalId,
      },
      body: JSON.stringify(posting),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    return {
      status: 'UNKNOWN',
      remoteId: null,
      remoteUrl: null,
      errorCode: 'DELIVERY_UNCONFIRMED',
      credentials,
    };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return {
      // A 5xx may have been applied before the website failed to answer.
      status: response.status >= 500 ? 'UNKNOWN' : 'FAILED',
      remoteId: null,
      remoteUrl: null,
      errorCode: 'CAREERS_HTTP_' + response.status,
      credentials,
    };
  }
  type Receipt = { id?: unknown; url?: unknown } | null;
  let data = null as Receipt;
  try {
    const text = await response.text();
    data = text.trim() ? (JSON.parse(text) as Receipt) : null;
  } catch {
    /* The receipt is optional; the 2xx status confirms the job was accepted. */
  }
  const id =
    typeof data?.id === 'string' || typeof data?.id === 'number'
      ? String(data.id).slice(0, 200)
      : null;
  return {
    status: 'PUBLISHED',
    remoteId: id,
    remoteUrl: publicUrl(data?.url),
    errorCode: null,
    credentials,
  };
}
