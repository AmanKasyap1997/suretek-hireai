import { Injectable, Logger } from '@nestjs/common';
import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { DbClient, DbService } from '../../../platform/database/db.service';
import { runWithTenant } from '../../../platform/database/tenant-context';
import { readConfig } from '../../../platform/config';
import { audit } from '../../../platform/audit/audit';
import { EmailPort, ContactEmail } from '../../../integrations';
import { VerificationMethod } from '../../../shared/enums';
const digest = (s: string) => createHash('sha256').update(s).digest();
const generic = {
  message:
    'If the verification was valid, your contact choices have been confirmed.',
};
@Injectable()
export class ContactVerificationService {
  constructor(
    private readonly db: DbService,
    private readonly email: EmailPort,
  ) {}
  private emailHash(email: string) {
    return createHmac('sha256', readConfig().JWT_SECRET)
      .update(email.toLowerCase())
      .digest('hex');
  }
  async issue(
    tx: DbClient,
    tenantId: string,
    candidateId: string,
    applicationId: string,
    email: string,
    slug: string,
    ids: string[],
  ): Promise<ContactEmail> {
    const id = randomUUID(),
      secret = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      Date.now() + readConfig().CONTACT_VERIFICATION_TTL_SECONDS * 1000,
    );
    await tx.query(
      'INSERT INTO contact_verifications(id,tenant_id,candidate_id,application_id,token_hash,email_hash,call_consent_id,recording_consent_id,transcription_consent_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        id,
        tenantId,
        candidateId,
        applicationId,
        digest(secret).toString('hex'),
        this.emailHash(email),
        ...ids,
        expiresAt,
      ],
    );
    await audit(
      tx,
      { tenantId, userId: null },
      'contact.verification_issued',
      'contact_verification',
      id,
    );
    return { to: email, tenantSlug: slug, token: `${id}.${secret}`, expiresAt };
  }
  async dispatch(message: ContactEmail) {
    try {
      await this.email.sendContactVerification(message);
    } catch {
      new Logger('ContactVerification').warn(
        'Verification email delivery failed',
      );
    }
  }
  async verify(slug: string, token: string, ip: string, userAgent: string) {
    const [id, secret] = token.split('.');
    const actual = digest(secret ?? '');
    const tenant = await this.db.one<{ id: string | null }>(
      'SELECT public.resolve_public_tenant($1) AS id',
      [slug],
    );
    if (!tenant?.id) {
      timingSafeEqual(actual, Buffer.alloc(32));
      return generic;
    }
    const tenantId = tenant.id;
    return runWithTenant(tenantId, async () => {
      const allowed = await this.db.one(
        `INSERT INTO public_intake_limits(tenant_id,bucket_key,window_start,hits) VALUES($1,$2,to_timestamp(floor(extract(epoch FROM now())/900)*900),1) ON CONFLICT(tenant_id,bucket_key,window_start) DO UPDATE SET hits=public_intake_limits.hits+1 WHERE public_intake_limits.hits<30 RETURNING id`,
        [
          tenantId,
          createHmac('sha256', readConfig().JWT_SECRET)
            .update(`verify:${ip}`)
            .digest('hex'),
        ],
      );
      if (!allowed) {
        timingSafeEqual(actual, Buffer.alloc(32));
        return generic;
      }
      return this.db.transaction(async (tx) => {
        const preliminary = await tx.one(
          'SELECT candidate_id FROM contact_verifications WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
        if (!preliminary) {
          timingSafeEqual(actual, Buffer.alloc(32));
          return generic;
        }
        const candidate = await tx.one(
          'SELECT email,erased_at FROM candidates WHERE tenant_id=$1 AND id=$2 FOR NO KEY UPDATE',
          [tenantId, preliminary.candidate_id],
        );
        const row = await tx.one(
          'SELECT * FROM contact_verifications WHERE tenant_id=$1 AND id=$2 FOR UPDATE',
          [tenantId, id],
        );
        const matches = timingSafeEqual(
          actual,
          Buffer.from(row.token_hash, 'hex'),
        );
        if (
          row.used_at ||
          row.attempts >= 5 ||
          new Date(row.expires_at).getTime() <= Date.now()
        )
          return generic;
        await tx.query(
          'UPDATE contact_verifications SET attempts=attempts+1 WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
        if (
          !matches ||
          !candidate ||
          candidate.erased_at ||
          this.emailHash(candidate.email) !== row.email_hash
        )
          return generic;
        await tx.query(
          'UPDATE contact_verifications SET used_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2',
          [tenantId, id],
        );
        const evidence = await tx.query(
          'SELECT * FROM consents WHERE tenant_id=$1 AND candidate_id=$2 AND id=ANY($3::uuid[]) ORDER BY sequence_id',
          [
            tenantId,
            row.candidate_id,
            [
              row.call_consent_id,
              row.recording_consent_id,
              row.transcription_consent_id,
            ],
          ],
        );
        for (const original of evidence) {
          const newer = await tx.one(
            'SELECT id FROM consents WHERE tenant_id=$1 AND candidate_id=$2 AND scope=$3 AND verified=true AND sequence_id>$4 LIMIT 1',
            [tenantId, row.candidate_id, original.scope, original.sequence_id],
          );
          if (newer) continue;
          const added = await tx.one(
            `INSERT INTO consents(tenant_id,candidate_id,scope,granted,source,captured_by,notice_version,ip_address,user_agent_hash,verified,verification_method,verification_id) VALUES($1,$2,$3,$4,'public-careers',NULL,$5,$6,$7,true,$8,$9) RETURNING id`,
            [
              tenantId,
              row.candidate_id,
              original.scope,
              original.granted,
              original.notice_version,
              ip,
              createHmac('sha256', readConfig().JWT_SECRET)
                .update(userAgent)
                .digest('hex'),
              VerificationMethod.EMAIL_TOKEN,
              id,
            ],
          );
          await audit(
            tx,
            { tenantId, userId: null },
            'consent.contact_verified',
            'consent',
            added!.id,
            { verificationId: id, scope: original.scope },
          );
        }
        await audit(
          tx,
          { tenantId, userId: null },
          'contact.verified',
          'contact_verification',
          id,
        );
        return generic;
      });
    });
  }
}
