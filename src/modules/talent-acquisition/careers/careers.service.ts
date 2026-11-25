import { ContactVerificationService } from './contact-verification.service';
import type {
  ContactEmail,
  RepeatApplicationEmail,
} from '../../../integrations';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { readConfig } from '../../../platform/config';
import { audit } from '../../../platform/audit/audit';
import { stageEvent } from '../../../shared/ta-history';
import { ApplicationStage, ConsentScope } from '../../../shared/enums';
import {
  StoredObject,
  CaptchaPort,
  EmailPort,
  validateResume,
} from '../../../integrations';
import { DocumentsService, type ResumeUpload } from '../documents';
import { ScreeningService } from '../screening';
import { ApplicationFields } from './careers.schemas';

const publicFields =
  'id,title,description,department,location,employment_type,openings,created_at';
const accepted = { message: 'Your application submission has been received.' };
@Injectable()
export class CareersService {
  constructor(
    private readonly db: DbService,
    private readonly captcha: CaptchaPort,
    private readonly documents: DocumentsService,
    private readonly verification: ContactVerificationService,
    private readonly email: EmailPort,
    @Optional() private readonly screening?: ScreeningService,
  ) {}
  private async tenant(slug: string) {
    const row = await this.db.one<{ id: string | null }>(
      'SELECT public.resolve_public_tenant($1) AS id',
      [slug],
    );
    if (!row?.id) throw new NotFoundException('Careers page not found');
    return row.id;
  }
  /** What the hosted careers pages need besides the jobs themselves. */
  private async page(tenantId: string) {
    const c = readConfig();
    const organization = await this.db.one<{ name: string }>(
      'SELECT name FROM tenants WHERE id=$1',
      [tenantId],
    );
    return {
      organization: { name: organization?.name ?? '' },
      noticeVersion: c.INTAKE_NOTICE_VERSION,
      resumeMaxBytes: c.RESUME_MAX_BYTES,
      captcha:
        c.CAPTCHA_PROVIDER === 'turnstile' && c.TURNSTILE_SITE_KEY
          ? {
              provider: 'turnstile' as const,
              siteKey: c.TURNSTILE_SITE_KEY,
              action: c.TURNSTILE_EXPECTED_ACTION ?? null,
            }
          : null,
    };
  }
  async list(slug: string, page: { limit: number; offset: number }) {
    const tenantId = await this.tenant(slug);
    return runWithTenant(tenantId, async () => {
      const total = await this.db.one<{ total: string }>(
        "SELECT count(*) AS total FROM jobs WHERE tenant_id=$1 AND status='PUBLISHED'",
        [tenantId],
      );
      return {
        data: await this.db.query(
          `SELECT ${publicFields} FROM jobs WHERE tenant_id=$1 AND status='PUBLISHED' ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3`,
          [tenantId, page.limit, page.offset],
        ),
        pagination: page,
        total: Number(total?.total ?? 0),
        ...(await this.page(tenantId)),
      };
    });
  }
  async get(slug: string, id: string) {
    const tenantId = await this.tenant(slug);
    return runWithTenant(tenantId, async () => {
      const job = await this.db.one(
        `SELECT ${publicFields} FROM jobs WHERE tenant_id=$1 AND id=$2 AND status='PUBLISHED'`,
        [tenantId, id],
      );
      if (!job) throw new NotFoundException('Job not found');
      return { ...job, ...(await this.page(tenantId)) };
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
        [`email-client:${email}:${ip}`, c.INTAKE_EMAIL_LIMIT],
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
  /**
   * An email address applied again to a job it already applied to. Nothing is
   * saved and the reply is the same as for a new application, so the form never
   * reveals who applied. The address on file is told instead, at most once a
   * day per application.
   */
  private async repeatNotice(
    tx: DbClient,
    tenantId: string,
    jobId: string,
    candidateId: string,
  ): Promise<RepeatApplicationEmail | undefined> {
    const existing = await tx.one<{
      id: string;
      created_at: Date;
      title: string;
      email: string;
      organization: string;
    }>(
      `SELECT a.id,a.created_at,j.title,c.email,t.name AS organization FROM applications a
        JOIN jobs j ON j.tenant_id=a.tenant_id AND j.id=a.job_id
        JOIN candidates c ON c.tenant_id=a.tenant_id AND c.id=a.candidate_id
        JOIN tenants t ON t.id=a.tenant_id
       WHERE a.tenant_id=$1 AND a.job_id=$2 AND a.candidate_id=$3`,
      [tenantId, jobId, candidateId],
    );
    if (!existing) return undefined;
    const due = await tx.one(
      `INSERT INTO application_repeat_notices(tenant_id,application_id) VALUES($1,$2)
       ON CONFLICT(tenant_id,application_id) DO UPDATE SET sent_at=now()
       WHERE application_repeat_notices.sent_at<now()-interval '1 day'
       RETURNING application_id`,
      [tenantId, existing.id],
    );
    await audit(
      tx,
      { tenantId, userId: null },
      'application.repeat_submission',
      'application',
      existing.id,
      { notified: !!due },
    );
    return due
      ? {
          to: existing.email,
          organizationName: existing.organization,
          jobTitle: existing.title,
          appliedAt: existing.created_at,
        }
      : undefined;
  }
  /** Not awaited, so a repeat answers no slower than before. */
  private sendRepeatNotice(message: RepeatApplicationEmail) {
    void this.email
      .sendRepeatApplication(message)
      .catch(() =>
        new Logger('Careers').warn('Repeat-application email delivery failed'),
      );
  }
  async apply(
    slug: string,
    jobId: string,
    input: ApplicationFields,
    resume: ResumeUpload | undefined,
    ip: string,
    userAgent: string,
  ) {
    const tenantId = await this.tenant(slug);
    return runWithTenant(tenantId, async () => {
      if (input.website) return accepted;
      const c = readConfig();
      if (input.noticeVersion !== c.INTAKE_NOTICE_VERSION)
        throw new BadRequestException('Use the current consent notice version');
      if (!(await this.captcha.verify(input.captchaToken, ip)))
        throw new ForbiddenException('Intake verification failed');
      if (!resume)
        throw new BadRequestException({
          message: 'Validation failed',
          errors: [
            { path: 'resume', message: 'Attach your resume (PDF or DOCX)' },
          ],
        });
      // Validate before the duplicate-application branch so malformed uploads
      // cannot reveal whether an email address has already applied.
      validateResume(resume.originalname, resume.buffer, c.RESUME_MAX_BYTES);
      await this.limit(tenantId, input.email, ip);
      let email: ContactEmail | undefined;
      let repeat: RepeatApplicationEmail | undefined;
      let created: string | undefined;
      const keys: StoredObject[] = [];
      try {
        const result = await this.db.transaction(async (tx) => {
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
          if (!application) {
            repeat = await this.repeatNotice(tx, tenantId, jobId, candidate.id);
            return accepted;
          }
          const actor = { tenantId, userId: null };
          await stageEvent(
            tx,
            actor,
            application.id,
            null,
            ApplicationStage.APPLIED,
          );
          await tx.query(
            `INSERT INTO application_details(tenant_id,application_id,phone,current_location,willing_to_relocate,total_experience_months,current_company,current_title,notice_period,last_working_day,current_ctc,expected_ctc,ctc_currency,linkedin_url,portfolio_url,cover_letter,source,referrer) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
            [
              tenantId,
              application.id,
              input.phone,
              input.currentLocation,
              input.willingToRelocate ?? null,
              input.totalExperienceMonths,
              input.currentCompany ?? null,
              input.currentTitle ?? null,
              input.noticePeriod,
              input.lastWorkingDay ?? null,
              input.currentCtc ?? null,
              input.expectedCtc,
              input.ctcCurrency,
              input.linkedinUrl ?? null,
              input.portfolioUrl ?? null,
              input.coverLetter ?? null,
              input.source,
              input.referrer ?? null,
            ],
          );
          const consentIds: string[] = [];
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
            consentIds.push(consent!.id);
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
          email = await this.verification.issue(
            tx,
            tenantId,
            candidate.id,
            application.id,
            input.email,
            slug,
            consentIds,
          );
          await this.documents.write(
            tx,
            actor,
            candidate.id,
            resume,
            (key) => keys.push(key),
            application.id,
          );
          await audit(
            tx,
            actor,
            'application.public_intake',
            'application',
            application.id,
            { source: input.source },
          );
          created = application.id;
          return accepted;
        });
        if (email) await this.verification.dispatch(email);
        if (repeat) this.sendRepeatNotice(repeat);
        // Queued in the background; the candidate's reply doesn't wait for it.
        if (created) this.screening?.automatic(tenantId, created);
        return result;
      } catch (error) {
        await this.documents.cleanup(keys);
        throw error;
      }
    });
  }
}
