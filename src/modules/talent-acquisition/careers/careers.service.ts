import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { readConfig } from '../../../platform/config';
import { audit } from '../../../platform/audit/audit';
import { stageEvent } from '../../../shared/ta-history';
import { ApplicationStage, ConsentScope } from '../../../shared/enums';
import { StoredObject, CaptchaPort } from '../../../integrations';
import { DocumentsService } from '../documents';
import { IntakeInput } from './careers.schemas';

const publicFields =
  'id,title,description,department,location,employment_type,openings,created_at';
const accepted = { message: 'Your application submission has been received.' };
@Injectable()
export class CareersService {
  constructor(
    private readonly db: DbService,
    private readonly captcha: CaptchaPort,
    private readonly documents: DocumentsService,
  ) {}
  private async tenant(slug: string) {
    const row = await this.db.one<{ id: string | null }>(
      'SELECT public.resolve_public_tenant($1) AS id',
      [slug],
    );
    if (!row?.id) throw new NotFoundException('Careers page not found');
    return row.id;
  }
  async list(slug: string, page: { limit: number; offset: number }) {
    const tenantId = await this.tenant(slug);
    return runWithTenant(tenantId, async () => ({
      data: await this.db.query(
        `SELECT ${publicFields} FROM jobs WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
        [tenantId, page.limit, page.offset],
      ),
      pagination: page,
      noticeVersion: readConfig().INTAKE_NOTICE_VERSION,
    }));
  }
  async get(slug: string, id: string) {
    const tenantId = await this.tenant(slug);
    return runWithTenant(tenantId, async () => {
      const job = await this.db.one(
        `SELECT ${publicFields} FROM jobs WHERE tenant_id=$1 AND id=$2 AND status='PUBLISHED'`,
        [tenantId, id],
      );
      if (!job) throw new NotFoundException('Job not found');
      return { ...job, noticeVersion: readConfig().INTAKE_NOTICE_VERSION };
    });
  }
  private async limit(tenantId: string, email: string, ip: string) {
    const c = readConfig();
    const allowed = await this.db.transaction(async (tx) => {
      await tx.query(
        "DELETE FROM public_intake_limits WHERE tenant_id=$1 AND window_start<now()-($2::int*2)*interval '1 second'",
        [tenantId, c.INTAKE_WINDOW_SECONDS],
      );
      for (const [key, limit] of [
        [`ip:${ip}`, c.INTAKE_IP_LIMIT],
        [`email:${email}`, c.INTAKE_EMAIL_LIMIT],
      ] as const) {
        const digest = createHmac('sha256', c.JWT_SECRET)
          .update(key)
          .digest('hex');
        const row = await tx.one(
          `INSERT INTO public_intake_limits(tenant_id,bucket_key,window_start,hits) VALUES($1,$2,to_timestamp(floor(extract(epoch FROM now())/$3)*$3),1) ON CONFLICT(tenant_id,bucket_key,window_start) DO UPDATE SET hits=public_intake_limits.hits+1 WHERE public_intake_limits.hits<$4 RETURNING id`,
          [tenantId, digest, c.INTAKE_WINDOW_SECONDS, limit],
        );
        if (!row) return false;
      }
      return true;
    });
    if (!allowed)
      throw new HttpException(
        'Intake rate limit exceeded',
        HttpStatus.TOO_MANY_REQUESTS,
      );
  }
  async apply(
    slug: string,
    jobId: string,
    input: IntakeInput,
    ip: string,
    userAgent: string,
  ) {
    const tenantId = await this.tenant(slug);
    return runWithTenant(tenantId, async () => {
      await this.limit(tenantId, input.email, ip);
      if (input.website) return accepted;
      const c = readConfig();
      if (input.noticeVersion !== c.INTAKE_NOTICE_VERSION)
        throw new BadRequestException('Use the current consent notice version');
      if (!(await this.captcha.verify(input.captchaToken, ip)))
        throw new ForbiddenException('Intake verification failed');
      const keys: StoredObject[] = [];
      try {
        return await this.db.transaction(async (tx) => {
          const job = await tx.one(
            "SELECT id FROM jobs WHERE tenant_id=$1 AND id=$2 AND status='PUBLISHED' FOR SHARE",
            [tenantId, jobId],
          );
          if (!job) throw new NotFoundException('Job not found');
          let candidate = await tx.one<{ id: string }>(
            `INSERT INTO candidates(tenant_id,full_name,email,phone) VALUES($1,$2,$3,$4) ON CONFLICT(tenant_id,lower(email)) DO NOTHING RETURNING id`,
            [tenantId, input.fullName, input.email, input.phone ?? null],
          );
          if (!candidate)
            candidate = await tx.one<{ id: string }>(
              'SELECT id FROM candidates WHERE tenant_id=$1 AND lower(email)=$2 AND erased_at IS NULL FOR NO KEY UPDATE',
              [tenantId, input.email],
            );
          if (!candidate)
            throw new BadRequestException('Submission could not be recorded');
          const application = await tx.one<{ id: string }>(
            'INSERT INTO applications(tenant_id,job_id,candidate_id) VALUES($1,$2,$3) ON CONFLICT(tenant_id,job_id,candidate_id) DO NOTHING RETURNING id',
            [tenantId, jobId, candidate.id],
          );
          // A repeated anonymous submission must not overwrite an existing person's data or consent.
          if (!application) return accepted;
          const actor = { tenantId, userId: null };
          await stageEvent(
            tx,
            actor,
            application.id,
            null,
            ApplicationStage.APPLIED,
          );
          for (const scope of Object.values(ConsentScope)) {
            const consent = await tx.one<{ id: string }>(
              `INSERT INTO consents(tenant_id,candidate_id,scope,granted,source,captured_by,notice_version,ip_address,user_agent_hash,verified) VALUES($1,$2,$3,$4,'public-careers',NULL,$5,$6,$7,false) RETURNING id`,
              [
                tenantId,
                candidate.id,
                scope,
                input.consents[scope],
                input.noticeVersion,
                ip,
                createHmac('sha256', c.JWT_SECRET)
                  .update(userAgent)
                  .digest('hex'),
              ],
            );
            await audit(
              tx,
              actor,
              'consent.intake_recorded',
              'consent',
              consent!.id,
              {
                candidateId: candidate.id,
                scope,
                granted: input.consents[scope],
                verified: false,
              },
            );
          }
          if (input.resume)
            await this.documents.write(
              tx,
              actor,
              candidate.id,
              {
                originalname: input.resume.filename,
                buffer: Buffer.from(input.resume.base64, 'base64'),
              },
              (key) => keys.push(key),
            );
          await audit(
            tx,
            actor,
            'application.public_intake',
            'application',
            application.id,
          );
          return accepted;
        });
      } catch (error) {
        await this.documents.cleanup(keys);
        throw error;
      }
    });
  }
}
