import { useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import {
  faArrowUpRightFromSquare,
  faBriefcase,
  faBullhorn,
  faChevronDown,
  faCircleInfo,
  faGlobe,
  faInbox,
  faPaperPlane,
  faTrashCan,
  faUser,
  faXmark,
} from '@fortawesome/free-solid-svg-icons';
import { api } from './api';

export type ChannelId =
  'careers_website' | 'company_announcement' | 'profile_post' | 'job_listing';
export type Channel = {
  channel: ChannelId;
  label: string;
  environment: 'production' | 'sandbox';
  ready: boolean;
  reason: string | null;
};
export type ChannelResult = {
  channel: ChannelId;
  label: string;
  status: string;
  url: string | null;
  message: string;
};
export type ChannelSelection = {
  channels: ChannelId[];
  pageUrn: string;
  pageStart: number;
  commentary: string;
  /** Who can see a profile post. */
  visibility: 'PUBLIC' | 'CONNECTIONS';
  applicationUrl: string;
  confirmed: boolean;
  /** Publish without posting anywhere else; excludes every channel. */
  hireaiOnly: boolean;
};
/** What happened after the job itself was published in HireAI. */
export type PublishOutcome = { results: ChannelResult[] } | { error: string };
type ChannelJob = {
  id: string;
  title: string;
  location: string;
  description?: string;
};
type PostJob = { title: string; location: string; description?: string };

/** The most text LinkedIn accepts in a post. */
export const POST_TEXT_LIMIT = 3000;

/** Room HireAI keeps at the end of a post for "Apply here: <link>". */
const APPLY_LINE_ROOM = 250;

/**
 * LinkedIn-ready post text built from the job: a "We are hiring" line and the
 * description with tidy bullets. HireAI adds the apply link after it when
 * posting. A description too long for one post is cut at a line, with a note
 * that the full text is behind the link.
 */
export function postTextFromJob(job: PostJob) {
  const head = `We are hiring: ${job.title.trim() || 'Job title'} — ${job.location.trim() || 'Location'}`;
  const body = (job.description ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd().replace(/^(\s*)[-*•]\s+/, '$1• '))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const limit = POST_TEXT_LIMIT - APPLY_LINE_ROOM;
  const full = [head, body].filter(Boolean).join('\n\n');
  if (full.length <= limit) return full;
  const more = '…\n\nRead the full description at the link below.';
  const room = limit - head.length - 2 - more.length;
  let kept = '';
  for (const line of body.split('\n')) {
    const next = kept ? `${kept}\n${line}` : line;
    if (next.length > room) break;
    kept = next;
  }
  // A first line longer than a whole post is cut at a word instead.
  if (!kept.trim()) kept = body.slice(0, room).replace(/\s+\S*$/, '');
  return `${head}\n\n${kept.trimEnd()}${more}`;
}

export const emptySelection: ChannelSelection = {
  channels: [],
  pageUrn: '',
  pageStart: 0,
  commentary: '',
  visibility: 'PUBLIC',
  applicationUrl: '',
  confirmed: false,
  hireaiOnly: false,
};
const order: ChannelId[] = [
  'careers_website',
  'company_announcement',
  'profile_post',
  'job_listing',
];
const details: Record<
  ChannelId,
  { title: string; description: string; icon: IconDefinition }
> = {
  careers_website: {
    title: 'Careers website',
    description:
      'Adds the job to your company website through the Careers CMS integration.',
    icon: faGlobe,
  },
  company_announcement: {
    title: 'LinkedIn company page post',
    description: 'Shares a “We’re hiring” post in your company page’s feed.',
    icon: faBullhorn,
  },
  profile_post: {
    title: 'LinkedIn profile post',
    description:
      'Shares the job on your personal LinkedIn profile, the one connected in Integrations.',
    icon: faUser,
  },
  job_listing: {
    title: 'LinkedIn Jobs',
    description:
      'Lists the job in LinkedIn Jobs and on your company page’s Jobs tab.',
    icon: faBriefcase,
  },
};
const isLinkedIn = (channel: ChannelId) => channel !== 'careers_website';
/** Channels that create a feed post with optional text. */
const isPost = (channel: ChannelId) =>
  channel === 'company_announcement' || channel === 'profile_post';

export function useJobChannels(enabled: boolean) {
  return useQuery({
    queryKey: ['job-channels'],
    queryFn: () => api<Channel[]>('/jobs/publishing/channels'),
    enabled,
    retry: false,
  });
}

/** Statuses that mean the channel already has (or may have) this job. */
function alreadySent(entry: ChannelResult | undefined) {
  if (!entry) return false;
  if (['PUBLISHED', 'SUBMITTED', 'PROCESSED', 'SENDING'].includes(entry.status))
    return true;
  // An unconfirmed careers post can be resent safely; LinkedIn cannot.
  return entry.status === 'UNKNOWN' && isLinkedIn(entry.channel);
}

/**
 * Why the selection can't be sent yet, or ''. Publishing needs an explicit
 * choice; posting an already published job needs at least one channel.
 */
/** A localhost link while developing: HireAI's own apply page, for tests. */
export const localDevLink = (url: URL) =>
  import.meta.env.DEV &&
  url.protocol === 'http:' &&
  (url.hostname === 'localhost' || url.hostname === '127.0.0.1');

export function selectionError(
  selection: ChannelSelection,
  mode: 'publish' | 'share',
  /** HireAI's apply page is used when no application link is entered. */
  applyPage = false,
) {
  const chosen = selection.channels;
  if (!chosen.length)
    return mode === 'share'
      ? 'Choose at least one channel.'
      : selection.hireaiOnly
        ? ''
        : 'Choose where to publish this job: select a channel, or select Only in HireAI.';
  if (chosen.includes('company_announcement') && !selection.pageUrn)
    return 'Choose the LinkedIn company page to post from.';
  const link = selection.applicationUrl.trim();
  if (link) {
    let url: URL | null = null;
    try {
      url = new URL(link);
    } catch {
      /* Reported below. */
    }
    if (
      !url ||
      !(url.protocol === 'https:' || localDevLink(url)) ||
      url.username ||
      url.password
    )
      return 'Enter the application page as a public https:// link.';
  } else if (
    chosen.some(isLinkedIn) &&
    !chosen.includes('careers_website') &&
    !applyPage
  )
    return 'Add the application page URL. LinkedIn sends candidates there to apply.';
  if (!selection.confirmed)
    return 'Confirm that you’ve reviewed the job before posting it publicly.';
  return '';
}

export function postToChannels(jobId: string, selection: ChannelSelection) {
  const chosen = order.filter((c) => selection.channels.includes(c));
  const company = chosen.includes('company_announcement');
  return api<{ results: ChannelResult[] }>(`/jobs/${jobId}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      channels: chosen,
      ...(selection.applicationUrl.trim()
        ? { applicationUrl: selection.applicationUrl.trim() }
        : {}),
      ...(company
        ? { pageUrn: selection.pageUrn, pageStart: selection.pageStart }
        : {}),
      ...(chosen.some(isPost) && selection.commentary.trim()
        ? { commentary: selection.commentary.trim() }
        : {}),
      ...(chosen.includes('profile_post')
        ? { visibility: selection.visibility }
        : {}),
      confirmed: true,
    }),
  });
}

/** Posts a just-published job, turning request failures into an outcome. */
export async function sendToChannels(
  jobId: string,
  selection: ChannelSelection,
  /** HireAI's apply page, used when no application link was entered. */
  applyUrl?: string,
): Promise<PublishOutcome | undefined> {
  if (!selection.channels.length) return undefined;
  try {
    return await postToChannels(
      jobId,
      applyUrl && !selection.applicationUrl.trim()
        ? { ...selection, applicationUrl: applyUrl }
        : selection,
    );
  } catch (reason) {
    return {
      error:
        reason instanceof Error
          ? reason.message
          : 'The job couldn’t be posted to the selected channels.',
    };
  }
}

const tone = (status: string) =>
  status === 'PUBLISHED'
    ? 'success'
    : status === 'FAILED'
      ? 'danger'
      : status === 'UNKNOWN'
        ? 'warning'
        : status === 'REMOVED'
          ? 'neutral'
          : 'info';
const statusText = (status: string) =>
  status === 'PUBLISHED'
    ? 'Posted'
    : status === 'FAILED'
      ? 'Failed'
      : status === 'UNKNOWN'
        ? 'Unconfirmed'
        : status === 'REMOVED'
          ? 'Removed'
          : 'In progress';
/** A live LinkedIn feed post that HireAI can delete. */
const removable = (entry: ChannelResult | undefined) =>
  !!entry && entry.status === 'PUBLISHED' && isPost(entry.channel);

/**
 * Deletes the job's LinkedIn post and frees the channel to post again.
 * Safe when the post was already deleted on LinkedIn.
 */
export function removePost(jobId: string, channel: ChannelId) {
  return api<ChannelResult>(`/jobs/${jobId}/channels/${channel}`, {
    method: 'DELETE',
  });
}

/** Removes a LinkedIn post after an inline confirmation. */
function RemovePost({
  title,
  onRemove,
}: {
  title: string;
  onRemove: () => Promise<void>;
}) {
  const [step, setStep] = useState<'idle' | 'confirm' | 'busy'>('idle');
  const [error, setError] = useState('');
  const keep = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (step === 'confirm' && !error) keep.current?.focus();
  }, [step, error]);
  async function remove() {
    setStep('busy');
    setError('');
    try {
      await onRemove();
      setStep('idle');
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'The post couldn’t be removed from LinkedIn.',
      );
      setStep('confirm');
    }
  }
  if (step === 'idle')
    return (
      <>
        <button
          type="button"
          className="channel-quiet-button channel-remove-button"
          onClick={() => setStep('confirm')}
        >
          <FontAwesomeIcon icon={faTrashCan} aria-hidden="true" /> Remove from
          LinkedIn
        </button>
        <span className="channel-hint channel-remove-hint">
          Already deleted it on LinkedIn? Remove it here too, so you can post
          the job again.
        </span>
      </>
    );
  return (
    <div className="channel-remove" role="group" aria-label={`Remove ${title}`}>
      <p>
        Remove this post from LinkedIn? Its reactions and comments are deleted
        with it. If you already deleted it on LinkedIn, this only updates
        HireAI.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="channel-remove-actions">
        <button
          type="button"
          className="int-danger-button"
          disabled={step === 'busy'}
          onClick={() => void remove()}
        >
          {step === 'busy' ? 'Removing…' : 'Remove post'}
        </button>
        <button
          ref={keep}
          type="button"
          disabled={step === 'busy'}
          onClick={() => {
            setStep('idle');
            setError('');
          }}
        >
          Keep post
        </button>
      </div>
    </div>
  );
}

function LinkedInPages({
  selection,
  update,
}: {
  selection: ChannelSelection;
  update: (patch: Partial<ChannelSelection>) => void;
}) {
  const pages = useQuery({
    queryKey: [
      'organization-integrations',
      'linkedin-pages',
      selection.pageStart,
    ],
    queryFn: () =>
      api<{ pages: { urn: string; name: string }[]; nextStart: number | null }>(
        `/organization/integrations/linkedin/pages?start=${selection.pageStart}`,
      ),
    retry: false,
  });
  if (pages.isPending)
    return (
      <p className="channel-hint" role="status">
        Loading your LinkedIn company pages…
      </p>
    );
  if (pages.isError)
    return (
      <p className="form-error" role="alert">
        {pages.error instanceof Error
          ? pages.error.message
          : 'LinkedIn company pages couldn’t be loaded.'}{' '}
        <button type="button" onClick={() => void pages.refetch()}>
          Try again
        </button>
      </p>
    );
  if (!pages.data.pages.length)
    return (
      <p className="form-error" role="alert">
        Your LinkedIn account can’t post for any company page. Reconnect
        LinkedIn with a page administrator account in Integrations.
      </p>
    );
  return (
    <div className="channel-field-row">
      <label className="form-field">
        Company page
        <span className="select-control">
          <select
            value={selection.pageUrn}
            onChange={(event) => update({ pageUrn: event.target.value })}
          >
            <option value="">Choose a page</option>
            {pages.data.pages.map((page) => (
              <option key={page.urn} value={page.urn}>
                {page.name}
              </option>
            ))}
          </select>
          <FontAwesomeIcon
            className="select-chevron"
            icon={faChevronDown}
            aria-hidden="true"
          />
        </span>
      </label>
      {(selection.pageStart > 0 || pages.data.nextStart != null) && (
        <button
          type="button"
          className="channel-quiet-button"
          onClick={() =>
            update({
              pageUrn: '',
              pageStart: pages.data.nextStart ?? 0,
            })
          }
        >
          {pages.data.nextStart != null ? 'More pages' : 'First pages'}
        </button>
      )}
    </div>
  );
}

export function ChannelPicker({
  query,
  selection,
  onChange,
  job,
  history = [],
  published = false,
  disabled = false,
  onRemove,
  applyUrl,
  applyPageLater = false,
}: {
  query: ReturnType<typeof useJobChannels>;
  selection: ChannelSelection;
  onChange: (next: ChannelSelection) => void;
  job: PostJob;
  history?: ChannelResult[];
  /** The job is already live in HireAI. */
  published?: boolean;
  disabled?: boolean;
  /** Deletes a channel's live LinkedIn post; offered when provided. */
  onRemove?: (channel: ChannelId) => Promise<void>;
  /** HireAI's own apply page for this job: candidates apply there. */
  applyUrl?: string;
  /** The job isn't saved yet: its HireAI apply page is used once it is. */
  applyPageLater?: boolean;
}) {
  const id = useId();
  const update = (patch: Partial<ChannelSelection>) =>
    onChange({ ...selection, ...patch });
  const channels = Array.isArray(query.data) ? query.data : [];
  const chosen = selection.channels;
  const linkedin = chosen.some(isLinkedIn);
  const jobText = postTextFromJob(job);
  function toggle(channel: ChannelId, on: boolean) {
    const next = on
      ? order.filter((c) => c === channel || chosen.includes(c))
      : chosen.filter((c) => c !== channel);
    update({
      channels: next,
      hireaiOnly: false,
      ...(next.length ? {} : { confirmed: false }),
      // The first post channel starts from the job description.
      ...(on && isPost(channel) && !selection.commentary.trim()
        ? { commentary: jobText }
        : {}),
    });
  }
  const hireaiKey = `${id}-hireai`;
  return (
    <fieldset className="channel-picker" disabled={disabled}>
      <legend>
        Where to publish
        {!published && (
          <span className="channel-required" aria-hidden="true">
            {' '}
            *
          </span>
        )}
      </legend>
      <p className="channel-hint">
        {published
          ? 'The job is open for applications in HireAI. Choose where else to post it:'
          : 'Required. Choose the channels to post the job to, or keep it only in HireAI. Either way, publishing opens it for applications in HireAI.'}
      </p>
      {(!published || channels.length > 0) && (
        <ul className="channel-list">
          {!published && (
            <li>
              <label
                className={[
                  'channel-option',
                  selection.hireaiOnly ? 'is-selected' : '',
                ].join(' ')}
              >
                <input
                  type="checkbox"
                  checked={selection.hireaiOnly}
                  aria-labelledby={`${hireaiKey}-title`}
                  aria-describedby={`${hireaiKey}-text`}
                  onChange={(event) =>
                    update(
                      event.target.checked
                        ? { hireaiOnly: true, channels: [], confirmed: false }
                        : { hireaiOnly: false },
                    )
                  }
                />
                <span className="channel-icon" aria-hidden="true">
                  <FontAwesomeIcon icon={faInbox} />
                </span>
                <span className="channel-copy">
                  <span className="channel-title">
                    <strong id={`${hireaiKey}-title`}>Only in HireAI</strong>
                  </span>
                  <span id={`${hireaiKey}-text`}>
                    Opens the job for applications in HireAI without posting it
                    anywhere else.
                  </span>
                </span>
              </label>
            </li>
          )}
          {channels.map((channel) => {
            const info = details[channel.channel];
            const previous = history.find((h) => h.channel === channel.channel);
            const sent = alreadySent(previous);
            const checked = chosen.includes(channel.channel);
            const key = `${id}-${channel.channel}`;
            return (
              <li key={channel.channel}>
                <label
                  className={[
                    'channel-option',
                    checked ? 'is-selected' : '',
                    !channel.ready || sent ? 'is-unavailable' : '',
                  ].join(' ')}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={!channel.ready || sent}
                    aria-labelledby={`${key}-title`}
                    aria-describedby={`${key}-text`}
                    onChange={(event) =>
                      toggle(channel.channel, event.target.checked)
                    }
                  />
                  <span className="channel-icon" aria-hidden="true">
                    <FontAwesomeIcon icon={info.icon} />
                  </span>
                  <span className="channel-copy">
                    <span className="channel-title">
                      <strong id={`${key}-title`}>{info.title}</strong>
                      {channel.environment === 'sandbox' && (
                        <span className="int-pill int-pill-warning">
                          Sandbox
                        </span>
                      )}
                      {previous && (
                        <span
                          className={`int-pill int-pill-${tone(previous.status)}`}
                        >
                          {statusText(previous.status)}
                        </span>
                      )}
                    </span>
                    <span id={`${key}-text`}>
                      {!channel.ready
                        ? channel.reason
                        : previous
                          ? previous.message
                          : info.description}
                    </span>
                  </span>
                </label>
                {(previous?.url || (onRemove && removable(previous))) && (
                  <div className="channel-actions">
                    {previous?.url && (
                      <a
                        className="channel-link"
                        href={previous.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {isLinkedIn(channel.channel)
                          ? 'View on LinkedIn'
                          : 'View on website'}{' '}
                        <FontAwesomeIcon
                          icon={faArrowUpRightFromSquare}
                          aria-hidden="true"
                        />
                      </a>
                    )}
                    {onRemove && removable(previous) && (
                      <RemovePost
                        title={info.title}
                        onRemove={() => onRemove(channel.channel)}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {query.isPending ? (
        <p className="channel-hint" role="status">
          Checking publishing channels…
        </p>
      ) : query.isError ? (
        <p className="form-error" role="alert">
          Publishing channels couldn’t be loaded.{' '}
          <button type="button" onClick={() => void query.refetch()}>
            Try again
          </button>
        </p>
      ) : !channels.length ? (
        <div className="channel-empty">
          <FontAwesomeIcon icon={faCircleInfo} aria-hidden="true" />
          <p>
            No other channels are enabled. To post jobs to your careers website
            or LinkedIn, connect, test and enable them in{' '}
            <Link to="/integrations">Integrations</Link>.
          </p>
        </div>
      ) : null}
      {chosen.some(isPost) && (
        <div className="channel-settings">
          <h4>LinkedIn post</h4>
          {chosen.includes('company_announcement') && (
            <LinkedInPages selection={selection} update={update} />
          )}
          {chosen.includes('profile_post') && (
            <label className="form-field">
              Who can see the profile post
              <span className="select-control">
                <select
                  value={selection.visibility}
                  onChange={(event) =>
                    update({
                      visibility: event.target
                        .value as ChannelSelection['visibility'],
                    })
                  }
                >
                  <option value="PUBLIC">Anyone on LinkedIn</option>
                  <option value="CONNECTIONS">Your connections only</option>
                </select>
                <FontAwesomeIcon
                  className="select-chevron"
                  icon={faChevronDown}
                  aria-hidden="true"
                />
              </span>
            </label>
          )}
          <div className="form-field">
            <label htmlFor={`${id}-text`}>Post text</label>
            <textarea
              id={`${id}-text`}
              rows={8}
              maxLength={POST_TEXT_LIMIT}
              value={selection.commentary}
              onChange={(event) => update({ commentary: event.target.value })}
              placeholder={`We are hiring: ${job.title || 'Job title'} — ${job.location || 'Location'}`}
              aria-describedby={`${id}-text-hint`}
            />
            <div className="channel-text-meta">
              <p id={`${id}-text-hint`} className="channel-hint">
                Starts from the job description; edit it as you like. LinkedIn
                shows the first few lines, then “…see more”. Leave it empty for
                a one-line post. The apply link is added at the end.
              </p>
              <span className="channel-count">
                {selection.commentary.length.toLocaleString('en-US')} /{' '}
                {POST_TEXT_LIMIT.toLocaleString('en-US')}
              </span>
            </div>
            {selection.commentary !== jobText && (
              <button
                type="button"
                className="channel-quiet-button channel-reset-text"
                onClick={() => update({ commentary: jobText })}
              >
                Use the job description
              </button>
            )}
          </div>
        </div>
      )}
      {linkedin &&
        (applyUrl || applyPageLater) &&
        !selection.applicationUrl.trim() &&
        !chosen.includes('careers_website') && (
          <p className="channel-apply-page" role="note">
            <strong>Candidates apply on HireAI.</strong>{' '}
            {applyUrl ? (
              <>
                The post links to this job’s apply page:{' '}
                <a href={applyUrl} target="_blank" rel="noopener noreferrer">
                  {applyUrl}
                </a>
              </>
            ) : (
              'The post links to this job’s apply page, created when it’s published.'
            )}
            {(applyUrl?.startsWith('http://') ||
              (!applyUrl && window.location.protocol === 'http:')) && (
              <small className="channel-local-link">
                Testing on this computer: it’s a local address, so candidates on
                LinkedIn can’t open it. Once HireAI runs on a public https://
                address, that link is used instead.
              </small>
            )}
          </p>
        )}
      {linkedin && (
        <div className="form-field channel-settings-field">
          <label htmlFor={`${id}-apply`}>
            {applyUrl || applyPageLater
              ? 'Another application page (optional)'
              : 'Application page URL'}
            {!chosen.includes('careers_website') &&
              !applyUrl &&
              !applyPageLater && (
                <span className="channel-required" aria-hidden="true">
                  {' '}
                  *
                </span>
              )}
          </label>
          <input
            id={`${id}-apply`}
            type="url"
            inputMode="url"
            maxLength={2048}
            value={selection.applicationUrl}
            onChange={(event) => update({ applicationUrl: event.target.value })}
            placeholder="https://careers.example.com/jobs/…"
            aria-describedby={`${id}-apply-hint`}
          />
          <p id={`${id}-apply-hint`} className="channel-hint">
            {applyUrl || applyPageLater
              ? 'Only if candidates should apply somewhere else.'
              : 'LinkedIn sends candidates here to apply. HireAI’s own apply page is used automatically once HireAI runs on a public https:// address.'}
            {chosen.includes('careers_website') &&
              ' Leave blank to use the job’s page on your careers website.'}
          </p>
        </div>
      )}
      {chosen.length > 0 && (
        <label className="channel-confirm">
          <input
            type="checkbox"
            checked={selection.confirmed}
            onChange={(event) => update({ confirmed: event.target.checked })}
          />
          <span>
            I’ve reviewed this job and authorize posting it publicly to the
            selected channels.
          </span>
        </label>
      )}
    </fieldset>
  );
}

export function ChannelResults({
  title,
  outcome,
  onDismiss,
}: {
  title: string;
  outcome: PublishOutcome;
  onDismiss?: () => void;
}) {
  return (
    <section className="channel-results" aria-label="Publishing results">
      <div className="channel-results-heading">
        <h2>Where {title} was posted</h2>
        {onDismiss && (
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Dismiss publishing results"
            onClick={onDismiss}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        )}
      </div>
      {'error' in outcome ? (
        <p className="form-error" role="alert">
          The job is published in HireAI, but it couldn’t be posted to the other
          channels: {outcome.error} Use Post to channels to try again.
        </p>
      ) : (
        <ul>
          {outcome.results.map((result) => (
            <li key={result.channel}>
              <span className={`int-pill int-pill-${tone(result.status)}`}>
                {statusText(result.status)}
              </span>
              <div>
                <strong>
                  {details[result.channel]?.title ?? result.label}
                </strong>
                <p>{result.message}</p>
              </div>
              {result.url && (
                <a href={result.url} target="_blank" rel="noopener noreferrer">
                  View{' '}
                  <FontAwesomeIcon
                    icon={faArrowUpRightFromSquare}
                    aria-hidden="true"
                  />
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Publishes an approved job, or posts a published one, to the chosen
 * channels from the job list.
 */
export function PublishDialog({
  job,
  mode,
  query,
  onClose,
  onDone,
  applyUrl,
}: {
  job: ChannelJob;
  mode: 'publish' | 'share';
  query: ReturnType<typeof useJobChannels>;
  onClose: () => void;
  onDone: (outcome: PublishOutcome | undefined) => void;
  /** HireAI's apply page for this job; LinkedIn needs a public HTTPS link. */
  applyUrl?: string;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [selection, setSelection] = useState(emptySelection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const history = useQuery({
    queryKey: ['job-channels', job.id],
    queryFn: () => api<ChannelResult[]>(`/jobs/${job.id}/channels`),
    enabled: mode === 'share',
    retry: false,
  });
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);
  async function remove(channel: ChannelId) {
    setNotice('');
    await removePost(job.id, channel);
    setNotice(
      `${details[channel].title} removed from LinkedIn. You can post the job there again.`,
    );
    await history.refetch();
  }
  async function submit() {
    const problem = selectionError(selection, mode, !!applyUrl);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (mode === 'publish')
        await api(`/jobs/${job.id}/publish`, { method: 'POST' });
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Unable to publish this job.',
      );
      setBusy(false);
      return;
    }
    const outcome = await sendToChannels(job.id, selection, applyUrl);
    setBusy(false);
    onDone(outcome);
  }
  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <div
        className="job-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              {mode === 'publish' ? 'Publish job' : 'Post to channels'}
            </h2>
            <p>
              {job.title} · {job.location}
            </p>
          </div>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </header>
        <ChannelPicker
          query={query}
          selection={selection}
          onChange={(next) => {
            setSelection(next);
            setError('');
          }}
          job={job}
          history={Array.isArray(history.data) ? history.data : []}
          published={mode === 'share'}
          disabled={busy}
          onRemove={mode === 'share' ? remove : undefined}
          applyUrl={applyUrl}
        />
        {notice && (
          <p className="form-success" role="status">
            {notice}
          </p>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="job-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={busy}
            onClick={() => void submit()}
          >
            <FontAwesomeIcon icon={faPaperPlane} aria-hidden="true" />{' '}
            {busy
              ? mode === 'publish'
                ? 'Publishing…'
                : 'Posting…'
              : mode === 'publish'
                ? 'Publish job'
                : 'Post to selected channels'}
          </button>
        </footer>
      </div>
    </div>
  );
}

/** What closing a job did to its LinkedIn posts. */
export type CloseOutcome = {
  removed: string[];
  failed: { title: string; message: string }[];
};

/**
 * Confirms closing a job and offers to delete its LinkedIn posts, so
 * candidates don't find a job that no longer accepts applications.
 */
export function CloseJobDialog({
  job,
  canRemove,
  onClose,
  onDone,
}: {
  job: ChannelJob;
  /** The user can see and delete the job's LinkedIn posts (HR Admin). */
  canRemove: boolean;
  onClose: () => void;
  onDone: (outcome: CloseOutcome) => void;
}) {
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const queryClient = useQueryClient();
  const [removeFromLinkedIn, setRemoveFromLinkedIn] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const history = useQuery({
    queryKey: ['job-channels', job.id],
    queryFn: () => api<ChannelResult[]>(`/jobs/${job.id}/channels`),
    enabled: canRemove,
    retry: false,
  });
  const posts = (Array.isArray(history.data) ? history.data : []).filter(
    removable,
  );
  const checking = canRemove && history.isPending;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    heading.current?.focus();
    return () => opener?.focus();
  }, []);
  async function submit() {
    setBusy(true);
    setError('');
    try {
      await api(`/jobs/${job.id}/close`, {
        method: 'POST',
        body: JSON.stringify({}),
      });
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : 'Unable to close this job.',
      );
      setBusy(false);
      return;
    }
    const outcome: CloseOutcome = { removed: [], failed: [] };
    if (removeFromLinkedIn)
      for (const post of posts) {
        const title = details[post.channel].title;
        try {
          await removePost(job.id, post.channel);
          outcome.removed.push(title);
        } catch (reason) {
          outcome.failed.push({
            title,
            message:
              reason instanceof Error
                ? reason.message
                : 'LinkedIn couldn’t remove the post.',
          });
        }
      }
    void queryClient.invalidateQueries({ queryKey: ['job-channels', job.id] });
    setBusy(false);
    onDone(outcome);
  }
  const titles = posts.map((post) => details[post.channel].title);
  return (
    <div
      className="job-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !busy) onClose();
      }}
    >
      <div
        className="job-dialog job-close-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="job-dialog-header">
          <div>
            <h2 id={titleId} ref={heading} tabIndex={-1}>
              Close job
            </h2>
            <p>
              {job.title} · {job.location}
            </p>
          </div>
          <button
            type="button"
            className="channel-icon-button"
            aria-label="Cancel closing"
            disabled={busy}
            onClick={onClose}
          >
            <FontAwesomeIcon icon={faXmark} aria-hidden="true" />
          </button>
        </header>
        <p className="job-dialog-text">
          Closing stops new applications in HireAI. A closed job can’t be
          reopened.
        </p>
        {checking ? (
          <p className="channel-hint" role="status">
            Checking where this job was posted…
          </p>
        ) : canRemove && history.isError ? (
          <p className="form-error" role="alert">
            HireAI couldn’t check this job’s LinkedIn posts. You can still close
            it, then delete any posts on LinkedIn directly.
          </p>
        ) : (
          posts.length > 0 && (
            <label className="channel-confirm job-close-remove">
              <input
                type="checkbox"
                checked={removeFromLinkedIn}
                disabled={busy}
                onChange={(event) =>
                  setRemoveFromLinkedIn(event.target.checked)
                }
              />
              <span>
                <strong>Also remove it from LinkedIn</strong>
                <span>
                  Deletes the {titles.join(' and ')}, with reactions and
                  comments, so candidates don’t find a closed job.
                </span>
              </span>
            </label>
          )
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <footer className="job-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button-primary"
            disabled={busy || checking}
            onClick={() => void submit()}
          >
            {busy ? 'Closing…' : 'Close job'}
          </button>
        </footer>
      </div>
    </div>
  );
}
