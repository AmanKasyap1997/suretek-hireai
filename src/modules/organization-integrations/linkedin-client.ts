import { BadGatewayException, BadRequestException } from '@nestjs/common';
export function linkedinHeaders(token: string) {
  const version = process.env.LINKEDIN_JOBS_VERSION || '202604';
  if (!/^20[0-9]{2}(0[1-9]|1[0-2])$/.test(version))
    throw new BadRequestException('Invalid LinkedIn API version configuration');
  return {
    Authorization: 'Bearer ' + token,
    'LinkedIn-Version': version,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
}
export async function sendLinkedIn(
  token: string,
  payload: Record<string, unknown>,
) {
  const response = await fetch(
    'https://api.linkedin.com/rest/simpleJobPostings',
    {
      method: 'POST',
      headers: {
        ...linkedinHeaders(token),
        'X-Restli-Method': 'batch_create',
      },
      body: JSON.stringify({ elements: [payload] }),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    return {
      status: response.status >= 500 ? 'UNKNOWN' : 'FAILED',
      remoteId: null,
      errorCode: 'LINKEDIN_HTTP_' + response.status,
    };
  }
  const data = (await response.json()) as {
    elements?: { id?: string; status?: number }[];
  };
  const item = data.elements?.[0];
  if (
    item?.id &&
    /^urn:li:simpleJobPostingTask:[a-zA-Z0-9-]+$/.test(item.id) &&
    item.status &&
    item.status >= 200 &&
    item.status < 300
  )
    return { status: 'SUBMITTED', remoteId: item.id, errorCode: null };
  return {
    status:
      item?.status && item.status >= 400 && item.status < 500
        ? 'FAILED'
        : 'UNKNOWN',
    remoteId: null,
    errorCode: 'INVALID_TASK_RECEIPT',
  };
}
export async function jobTask(token: string, id: string) {
  const response = await fetch(
    'https://api.linkedin.com/rest/simpleJobPostingTasks?ids=' +
      encodeURIComponent(id),
    {
      headers: linkedinHeaders(token),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new BadGatewayException(
      'LinkedIn task status is unavailable; try again later',
    );
  }
  const data = (await response.json()) as {
    results?: Record<
      string,
      {
        status?: string;
        jobPosting?: string;
        errorCode?: unknown;
        errorMessage?: string;
      }
    >;
  };
  const items = Object.entries(data.results ?? {})
    .filter(([key]) => key === id || key.startsWith(id + '-'))
    .map(([, v]) => v);
  if (!items.length) return { status: 'SUBMITTED', url: null };
  if (items.some((v) => v.status === 'FAILED' || v.errorCode || v.errorMessage))
    return { status: 'FAILED', url: null };
  if (items.every((v) => v.status === 'SUCCEEDED')) {
    const urn = items[0].jobPosting;
    return {
      status: 'PUBLISHED',
      url:
        urn && /^urn:li:jobPosting:[0-9]+$/.test(urn)
          ? 'https://www.linkedin.com/jobs/view/' + urn.split(':').pop()
          : null,
    };
  }
  return {
    status: items.every((v) => v.status === 'PROCESSED')
      ? 'PROCESSED'
      : 'SUBMITTED',
    url: null,
  };
}
