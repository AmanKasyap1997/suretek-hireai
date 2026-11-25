import { BadGatewayException, BadRequestException } from '@nestjs/common';
/** The post ID LinkedIn returns when a post is created. */
export const linkedinPostUrn = /^urn:li:(share|ugcPost):[0-9]+$/;
/** The most text LinkedIn accepts in a post. */
export const POST_TEXT_LIMIT = 3000;
/** Characters the Posts API's "little" text format reserves. */
const littleReserved = /[|{}@[\]()<>#\\*_~]/g;
const escapeLittle = (text: string) => text.replace(littleReserved, '\\$&');
const encodeLittle = (text: string) =>
  text
    // A # starting a word with a letter is a hashtag; split() keeps the word.
    .split(/(?<![\p{L}\p{N}_])#([\p{N}_]*\p{L}[\p{L}\p{N}_]*)/u)
    .map((part, index) =>
      index % 2 ? `{hashtag|\\#|${escapeLittle(part)}}` : escapeLittle(part),
    )
    .join('');
/**
 * Encodes plain text for a Posts API commentary. Reserved characters are
 * escaped, because LinkedIn may drop text after an unescaped one, and #words
 * become hashtags. Text that won't fit once encoded is shortened at a word.
 */
export function littleText(text: string, max = POST_TEXT_LIMIT) {
  const whole = encodeLittle(text);
  if (whole.length <= max) return whole;
  let end = text.length;
  for (;;) {
    let space = end - 1;
    while (space > 0 && !/\s/.test(text[space])) space--;
    end = space > 0 ? space : end - 1;
    const encoded = encodeLittle(text.slice(0, end).trimEnd() + '…');
    if (encoded.length <= max) return encoded;
  }
}
export function linkedinHeaders(token: string, jobs = false) {
  const version =
    process.env[
      jobs ? 'LINKEDIN_JOBS_VERSION' : 'LINKEDIN_MARKETING_VERSION'
    ] || (jobs ? '202604' : '202611');
  if (!/^20[0-9]{2}(0[1-9]|1[0-2])$/.test(version))
    throw new BadRequestException('Invalid LinkedIn API version configuration');
  return {
    Authorization: 'Bearer ' + token,
    'LinkedIn-Version': version,
    'X-Restli-Protocol-Version': '2.0.0',
    'Content-Type': 'application/json',
  };
}
export async function companyPages(token: string, start = 0) {
  const response = await fetch(
    'https://api.linkedin.com/rest/organizationAcls?q=roleAssignee&state=APPROVED&count=25&start=' +
      start,
    {
      headers: linkedinHeaders(token),
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new BadGatewayException(
      'LinkedIn page access was denied or unavailable. Reconnect with approved company-page permissions.',
    );
  }
  const data = (await response.json()) as {
    elements?: {
      organization?: string;
      organizationTarget?: string;
      role?: string;
      state?: string;
    }[];
    paging?: { links?: { rel: string }[] };
  };
  const entries = (data.elements ?? []).filter(
    (v) =>
      v.state === 'APPROVED' &&
      [
        'ADMINISTRATOR',
        'CONTENT_ADMIN',
        'DIRECT_SPONSORED_CONTENT_POSTER',
      ].includes(v.role ?? ''),
  );
  const urns = [
    ...new Set(
      entries
        .map((v) => v.organization ?? v.organizationTarget)
        .filter(
          (v): v is string => !!v && /^urn:li:organization:[0-9]+$/.test(v),
        ),
    ),
  ];
  const pages = await Promise.all(
    urns.map(async (urn) => {
      let name = 'Company page ' + urn.split(':').pop();
      try {
        const detail = await fetch(
          'https://api.linkedin.com/rest/organizations/' + urn.split(':').pop(),
          {
            headers: linkedinHeaders(token),
            redirect: 'error',
            signal: AbortSignal.timeout(5000),
          },
        );
        if (detail.ok) {
          const result = (await detail.json()) as { localizedName?: string };
          if (typeof result.localizedName === 'string')
            name = result.localizedName.slice(0, 200);
        } else await detail.body?.cancel();
      } catch {
        /* The verified page ID remains usable if optional naming is unavailable. */
      }
      return { urn, name };
    }),
  );
  return {
    pages,
    nextStart: data.paging?.links?.some((v) => v.rel === 'next')
      ? start + 25
      : null,
  };
}
/** The signed-in member, from Sign In with LinkedIn using OpenID Connect. */
export async function linkedinMember(token: string) {
  const response = await fetch('https://api.linkedin.com/v2/userinfo', {
    headers: { Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new BadGatewayException(
      'LinkedIn profile access was denied or unavailable. Reconnect LinkedIn profile.',
    );
  }
  const data = (await response.json()) as { sub?: unknown; name?: unknown };
  if (typeof data.sub !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(data.sub))
    throw new BadGatewayException('LinkedIn didn’t return a member ID');
  return {
    id: data.sub,
    name: typeof data.name === 'string' ? data.name.slice(0, 200) : '',
  };
}
export async function ownsPage(token: string, urn: string, start = 0) {
  const result = await companyPages(token, start);
  return result.pages.some((p) => p.urn === urn);
}
export async function sendLinkedIn(
  token: string,
  channel: string,
  payload: unknown,
) {
  const jobs = channel === 'job_listing';
  // Share on LinkedIn members post through the unversioned UGC API.
  const profile = channel === 'profile_post';
  const response = await fetch(
    profile
      ? 'https://api.linkedin.com/v2/ugcPosts'
      : 'https://api.linkedin.com/rest/' +
          (jobs ? 'simpleJobPostings' : 'posts'),
    {
      method: 'POST',
      headers: profile
        ? {
            Authorization: 'Bearer ' + token,
            'X-Restli-Protocol-Version': '2.0.0',
            'Content-Type': 'application/json',
          }
        : {
            ...linkedinHeaders(token, jobs),
            ...(jobs ? { 'X-Restli-Method': 'batch_create' } : {}),
          },
      body: JSON.stringify(jobs ? { elements: [payload] } : payload),
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
  if (!jobs) {
    const id = response.headers.get('x-restli-id');
    await response.body?.cancel();
    return id && linkedinPostUrn.test(id)
      ? { status: 'PUBLISHED', remoteId: id, errorCode: null }
      : { status: 'UNKNOWN', remoteId: null, errorCode: 'MISSING_RECEIPT' };
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
/**
 * Deletes a post HireAI created and returns LinkedIn's HTTP status.
 * Deletion is idempotent: a post already deleted on LinkedIn returns 204.
 */
export async function deleteLinkedInPost(
  token: string,
  channel: string,
  urn: string,
) {
  if (!linkedinPostUrn.test(urn))
    throw new BadRequestException('Invalid LinkedIn post ID');
  // Profile posts were created through the UGC API; company posts through Posts.
  const profile = channel === 'profile_post';
  const response = await fetch(
    (profile
      ? 'https://api.linkedin.com/v2/ugcPosts/'
      : 'https://api.linkedin.com/rest/posts/') + encodeURIComponent(urn),
    {
      method: 'DELETE',
      headers: profile
        ? {
            Authorization: 'Bearer ' + token,
            'X-Restli-Protocol-Version': '2.0.0',
          }
        : { ...linkedinHeaders(token), 'X-RestLi-Method': 'DELETE' },
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    },
  );
  await response.body?.cancel();
  return response.status;
}
export async function jobTask(token: string, id: string) {
  const response = await fetch(
    'https://api.linkedin.com/rest/simpleJobPostingTasks?ids=' +
      encodeURIComponent(id),
    {
      headers: linkedinHeaders(token, true),
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
