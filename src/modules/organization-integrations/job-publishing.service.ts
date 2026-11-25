import {
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../../platform/database/db.service';
import { audit } from '../../platform/audit/audit';
import { Actor, Role } from '../../shared/actor';
import { decryptSecret, encryptSecret } from '../super-admin/secrets';
import {
  CareersDelivery,
  CareersPosting,
  careersPublishConfigured,
  publishCareersJob,
} from './careers-client';
import { Method } from './catalog';
import {
  JobChannelsInput,
  PublishingChannel,
  publishingChannels,
  RemovableChannel,
} from './job-publishing.schemas';
import { LinkedInService } from './linkedin.service';

const labels: Record<PublishingChannel, string> = {
  careers_website: 'Careers website',
  company_announcement: 'LinkedIn company page post',
  profile_post: 'LinkedIn profile post',
  job_listing: 'LinkedIn Jobs',
};
const providers = {
  careers_website: 'careers_cms',
  company_announcement: 'linkedin',
  profile_post: 'linkedin_profile',
  job_listing: 'linkedin_jobs',
} as const satisfies Record<PublishingChannel, string>;
/** Rows in these states hold the single dispatch slot for a job and channel. */
const active = ['SENDING', 'SUBMITTED', 'PUBLISHED', 'PROCESSED', 'UNKNOWN'];

interface Connection {
  id: string;
  provider: (typeof providers)[PublishingChannel];
  environment: 'production' | 'sandbox';
  method: Method;
  encrypted_credentials: string;
  version: string;
  /** Who last authorized the connection. */
  updated_by: string;
}
interface JobRow {
  id: string;
  title: string;
  description: string;
  department: string;
  location: string;
  employment_type: string;
  openings: number;
  salary_min: string | number | null;
  salary_max: string | number | null;
  status: string;
  updated_at: Date;
}
interface PublicationRow {
  status: string;
  remote_url: string | null;
  error_code: string | null;
}
export interface ChannelResult {
  channel: PublishingChannel;
  label: string;
  status: string;
  url: string | null;
  message: string;
}

function describe(
  channel: PublishingChannel,
  status: string,
  code: string | null,
) {
  const linkedin = channel !== 'careers_website';
  switch (status) {
    case 'PUBLISHED':
      return linkedin ? 'Posted on LinkedIn.' : 'Sent to your careers website.';
    case 'SUBMITTED':
      return 'Sent to LinkedIn. It can take a few minutes to go live.';
    case 'PROCESSED':
      return 'LinkedIn processed the job but hasn’t confirmed a live listing yet.';
    case 'SENDING':
      return 'Sending…';
    case 'REMOVED':
      return 'Removed from LinkedIn. You can post it again.';
    case 'UNKNOWN':
      return linkedin
        ? 'LinkedIn didn’t confirm the post. Check LinkedIn before trying again; HireAI won’t resend it automatically.'
        : 'Your careers website didn’t confirm the job. Send it again; the website updates the same job instead of adding a copy.';
  }
  if (code === 'CAREERS_AUTH_FAILED')
    return 'HireAI couldn’t sign in to your careers website. Test the Careers CMS connection in Integrations.';
  if (code === 'CAREERS_RECONNECT')
    return 'The Careers CMS connection must be reconnected in Integrations.';
  if (code === 'CAREERS_NOT_SENT')
    return 'The job wasn’t sent. Check the careers website setup, then try again.';
  const http = /_HTTP_(\d{3})$/.exec(code ?? '');
  if (
    http?.[1] === '422' &&
    (channel === 'company_announcement' || channel === 'profile_post')
  )
    // LinkedIn rejects a post identical to one made in the last 10 minutes.
    return 'LinkedIn rejected the post (HTTP 422). If the same post was made in the last 10 minutes, change the post text or wait, then try again.';
  const name = linkedin ? 'LinkedIn' : 'Your careers website';
  return http
    ? `${name} rejected the job (HTTP ${http[1]}).`
    : `${name} didn’t accept the job.`;
}
function outcome(
  channel: PublishingChannel,
  row: PublicationRow,
  note?: string,
): ChannelResult {
  return {
    channel,
    label: labels[channel],
    status: row.status,
    url: row.remote_url ?? null,
    message: note ?? describe(channel, row.status, row.error_code),
  };
}
function failed(channel: PublishingChannel, message: string): ChannelResult {
  return {
    channel,
    label: labels[channel],
    status: 'FAILED',
    url: null,
    message,
  };
}

/**
 * Sends a published job to the external channels an HR Admin has enabled:
 * the organization's careers website (Careers CMS) and LinkedIn.
 */
@Injectable()
export class JobPublishingService {
  constructor(
    private readonly db: DbService,
    private readonly linkedin: LinkedInService,
  ) {}

  private async organization(actor: Actor) {
    if (actor.role !== Role.HR_ADMIN) throw new ForbiddenException();
    const org = await this.db.one(
      'SELECT is_platform,status,deleted_at,enabled_modules,slug FROM tenants WHERE id=$1',
      [actor.tenantId],
    );
    if (
      !org ||
      org.is_platform ||
      org.deleted_at ||
      org.status === 'suspended' ||
      !org.enabled_modules.includes('hiring')
    )
      throw new ForbiddenException('Organization hiring is unavailable');
    return org.slug as string;
  }

  /** Enabled organization connections, preferring production over sandbox. */
  private connections(actor: Actor) {
    return this.db.query<Connection>(
      `SELECT DISTINCT ON (c.provider) c.id,c.provider,c.environment,c.method,c.encrypted_credentials,c.updated_at::text AS version,c.updated_by
       FROM integration_configs c
       JOIN integration_providers p ON p.provider=c.provider AND p.enabled AND p.revision=c.provider_revision
       WHERE c.tenant_id=$1 AND c.organization_id=$1 AND c.provider=ANY($2)
         AND c.status='enabled' AND c.encrypted_credentials<>''
       ORDER BY c.provider,(c.environment='production') DESC`,
      [actor.tenantId, Object.values(providers)],
    );
  }

  /** Why an enabled connection still can't post, or null when it can. */
  private blocked(
    actor: Actor,
    channel: PublishingChannel,
    connection: Connection,
  ) {
    if (channel === 'careers_website')
      return careersPublishConfigured()
        ? null
        : 'The deployment operator must set INTEGRATION_CAREERS_CMS_PUBLISH_URL to your website’s HTTPS job endpoint.';
    if (connection.environment !== 'production')
      return 'Only the sandbox LinkedIn connection is enabled. Test and enable the production connection in Integrations.';
    if (channel === 'profile_post' && connection.updated_by !== actor.userId)
      return 'Only the HR admin who connected LinkedIn profile can post to it. To post on your own profile, reconnect it with your LinkedIn account in Integrations.';
    if (
      channel === 'job_listing' &&
      process.env.LINKEDIN_JOBS_APPROVED !== 'true'
    )
      return 'LinkedIn Jobs needs approved partner access, which the platform hasn’t configured.';
    return null;
  }

  async channels(actor: Actor) {
    await this.organization(actor);
    const rows = await this.connections(actor);
    return publishingChannels.flatMap((channel) => {
      const connection = rows.find((r) => r.provider === providers[channel]);
      if (!connection) return [];
      const reason = this.blocked(actor, channel, connection);
      return [
        {
          channel,
          label: labels[channel],
          environment: connection.environment,
          ready: !reason,
          reason,
        },
      ];
    });
  }

  /** The latest delivery for each channel this job was sent to. */
  async history(actor: Actor, jobId: string) {
    await this.organization(actor);
    const rows = await this.db.query<
      PublicationRow & { channel: PublishingChannel; updated_at: string }
    >(
      `SELECT DISTINCT ON (channel) channel,status,remote_url,error_code,updated_at
       FROM integration_publications
       WHERE tenant_id=$1 AND job_id=$2 AND status<>'DRAFT'
       ORDER BY channel,(status=ANY($3)) DESC,updated_at DESC`,
      [actor.tenantId, jobId, active],
    );
    return rows
      .filter((row) => publishingChannels.includes(row.channel))
      .map((row) => ({
        ...outcome(row.channel, row),
        updatedAt: row.updated_at,
      }));
  }

  async publish(actor: Actor, jobId: string, input: JobChannelsInput) {
    const slug = await this.organization(actor);
    const job = await this.db.one<JobRow>(
      `SELECT id,title,description,department,location,employment_type,openings,salary_min,salary_max,status,updated_at
       FROM jobs WHERE tenant_id=$1 AND id=$2`,
      [actor.tenantId, jobId],
    );
    if (!job) throw new NotFoundException('Job not found.');
    if (job.status !== 'PUBLISHED')
      throw new ConflictException(
        'Publish the job in HireAI before posting it to other channels.',
      );
    const connections = await this.connections(actor);
    const results: ChannelResult[] = [];
    let applyUrl = input.applicationUrl ?? null;
    for (const channel of publishingChannels) {
      if (!input.channels.includes(channel)) continue;
      const connection = connections.find(
        (r) => r.provider === providers[channel],
      );
      const reason = connection
        ? this.blocked(actor, channel, connection)
        : `${labels[channel]} isn’t enabled for your organization. Connect, test and enable it in Integrations.`;
      if (reason) {
        results.push(failed(channel, reason));
      } else if (channel === 'careers_website') {
        const result = await this.toCareers(actor, slug, job, connection!);
        // The website's job page doubles as LinkedIn's application link.
        applyUrl ??= result.url;
        results.push(result);
      } else {
        results.push(
          await this.toLinkedIn(actor, jobId, channel, input, applyUrl),
        );
      }
    }
    return { results };
  }

  /**
   * Removes the job's LinkedIn post, for example when the job closes or the
   * post was already deleted on LinkedIn, so the job can be posted again.
   */
  async remove(actor: Actor, jobId: string, channel: RemovableChannel) {
    await this.organization(actor);
    await this.linkedin.removePost(actor, jobId, channel);
    return outcome(channel, {
      status: 'REMOVED',
      remote_url: null,
      error_code: null,
    });
  }

  private async toLinkedIn(
    actor: Actor,
    jobId: string,
    channel: Exclude<PublishingChannel, 'careers_website'>,
    input: JobChannelsInput,
    applyUrl: string | null,
  ) {
    const existing = await this.db.one<PublicationRow>(
      'SELECT status,remote_url,error_code FROM integration_publications WHERE tenant_id=$1 AND job_id=$2 AND channel=$3 AND status=ANY($4) ORDER BY updated_at DESC LIMIT 1',
      [actor.tenantId, jobId, channel, active],
    );
    if (existing)
      return outcome(
        channel,
        existing,
        'Already sent for this job. ' +
          describe(channel, existing.status, existing.error_code),
      );
    if (!applyUrl)
      return failed(
        channel,
        'Add an application page URL. LinkedIn sends candidates there to apply.',
      );
    try {
      const preview = await this.linkedin.preview(actor, {
        jobId,
        channel,
        applicationUrl: applyUrl,
        pageUrn: channel === 'company_announcement' ? input.pageUrn : undefined,
        pageStart: input.pageStart,
        commentary: input.commentary || undefined,
        ...(channel === 'profile_post' ? { visibility: input.visibility } : {}),
      });
      const sent = await this.linkedin.publish(actor, preview.id);
      const row = await this.db.one<PublicationRow>(
        'SELECT status,remote_url,error_code FROM integration_publications WHERE tenant_id=$1 AND id=$2',
        [actor.tenantId, sent.id],
      );
      return outcome(
        channel,
        row ?? { status: sent.status, remote_url: null, error_code: null },
      );
    } catch (error) {
      return failed(
        channel,
        error instanceof HttpException
          ? error.message
          : 'LinkedIn is unavailable right now. Try again later.',
      );
    }
  }

  private async toCareers(
    actor: Actor,
    slug: string,
    job: JobRow,
    connection: Connection,
  ): Promise<ChannelResult> {
    const channel = 'careers_website';
    const posting: CareersPosting = {
      event: 'job.published',
      externalId: `${actor.tenantId}:${job.id}`,
      organization: slug,
      job: {
        id: job.id,
        title: job.title,
        description: job.description,
        department: job.department,
        location: job.location,
        employmentType: job.employment_type,
        openings: job.openings,
        salary:
          job.salary_min == null && job.salary_max == null
            ? null
            : {
                min: job.salary_min == null ? null : Number(job.salary_min),
                max: job.salary_max == null ? null : Number(job.salary_max),
                currency: 'INR',
              },
        publishedAt: new Date(job.updated_at).toISOString(),
      },
    };
    let claim: { id: string } | ChannelResult;
    try {
      claim = await this.db.transaction(async (tx) => {
        const current = await tx.one<
          PublicationRow & { id: string; fresh: boolean }
        >(
          `SELECT id,status,remote_url,error_code,(updated_at>now()-interval '2 minutes') AS fresh
           FROM integration_publications
           WHERE tenant_id=$1 AND job_id=$2 AND channel=$3 AND status=ANY($4) FOR UPDATE`,
          [actor.tenantId, job.id, channel, active],
        );
        if (current?.status === 'PUBLISHED')
          return outcome(channel, current, 'Already on your careers website.');
        if (current?.status === 'SENDING' && current.fresh)
          return outcome(
            channel,
            current,
            'Already being sent. Check again in a minute.',
          );
        const payload = JSON.stringify({
          request: posting,
          connectionUpdatedAt: connection.version,
        });
        // The website upserts by externalId, so an unconfirmed send may be repeated.
        const row = current
          ? await tx.one<{ id: string }>(
              "UPDATE integration_publications SET status='SENDING',connection_id=$3,payload=$4,job_updated_at=$5,error_code=NULL,updated_at=now() WHERE tenant_id=$1 AND id=$2 RETURNING id",
              [
                actor.tenantId,
                current.id,
                connection.id,
                payload,
                job.updated_at,
              ],
            )
          : await tx.one<{ id: string }>(
              "INSERT INTO integration_publications(tenant_id,job_id,connection_id,channel,payload,job_updated_at,status,created_by) VALUES($1,$2,$3,$4,$5,$6,'SENDING',$7) RETURNING id",
              [
                actor.tenantId,
                job.id,
                connection.id,
                channel,
                payload,
                job.updated_at,
                actor.userId,
              ],
            );
        await audit(
          tx,
          actor,
          'integration.publication_requested',
          'integration_publication',
          row!.id,
          { channel, job_id: job.id },
        );
        return { id: row!.id };
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505')
        return {
          channel,
          label: labels[channel],
          status: 'SENDING',
          url: null,
          message: 'Already being sent. Check again in a minute.',
        };
      throw error;
    }
    if ('channel' in claim) return claim;
    const publicationId = claim.id;
    const context = [
      'organization',
      actor.tenantId,
      'careers_cms',
      connection.environment,
    ].join(':');
    let stored: Record<string, string> | null = null;
    let delivery: CareersDelivery;
    try {
      stored = JSON.parse(
        decryptSecret(connection.encrypted_credentials, context),
      ) as Record<string, string>;
    } catch {
      /* Reported as a reconnect request without exposing decryption details. */
    }
    if (!stored)
      delivery = {
        status: 'FAILED',
        remoteId: null,
        remoteUrl: null,
        errorCode: 'CAREERS_RECONNECT',
        credentials: {},
      };
    else
      try {
        delivery = await publishCareersJob(connection.method, stored, posting);
      } catch {
        // Thrown only before the request is sent, so nothing reached the website.
        delivery = {
          status: 'FAILED',
          remoteId: null,
          remoteUrl: null,
          errorCode: 'CAREERS_NOT_SENT',
          credentials: stored,
        };
      }
    if (
      stored &&
      JSON.stringify(delivery.credentials) !== JSON.stringify(stored)
    )
      // Keep rotated tokens; skip if the connection changed meanwhile.
      await this.db.query(
        'UPDATE integration_configs SET encrypted_credentials=$3 WHERE tenant_id=$1 AND id=$2 AND encrypted_credentials=$4',
        [
          actor.tenantId,
          connection.id,
          encryptSecret(JSON.stringify(delivery.credentials), context),
          connection.encrypted_credentials,
        ],
      );
    await this.db.transaction(async (tx) => {
      await tx.query(
        'UPDATE integration_publications SET status=$3,remote_id=$4,remote_url=$5,error_code=$6,updated_at=now() WHERE tenant_id=$1 AND id=$2',
        [
          actor.tenantId,
          publicationId,
          delivery.status,
          delivery.remoteId,
          delivery.remoteUrl,
          delivery.errorCode,
        ],
      );
      await audit(
        tx,
        actor,
        'integration.publication_result',
        'integration_publication',
        publicationId,
        { status: delivery.status, channel },
      );
    });
    return outcome(channel, {
      status: delivery.status,
      remote_url: delivery.remoteUrl,
      error_code: delivery.errorCode,
    });
  }
}
