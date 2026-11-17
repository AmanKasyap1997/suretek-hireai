import { SmtpEmail } from './smtp-email';
import { ClamAvScanner } from './clamav';
import { TurnstileCaptcha } from './turnstile';
import { EmailPort, DevelopmentLogEmail, DisabledEmail } from './email';
import { Module } from '@nestjs/common';
import { readConfig } from '../platform/config';
import {
  ObjectStoragePort,
  LocalObjectStorage,
  S3ObjectStorage,
} from './storage';
import {
  CaptchaPort,
  DisabledCaptcha,
  MalwareScanPort,
  PendingMalwareScanner,
} from './intake';
import { CalendarPort, DisabledCalendar } from './calendar';
@Module({
  providers: [
    {
      provide: ObjectStoragePort,
      useFactory: () => {
        const c = readConfig();
        if (c.RESUME_STORAGE === 'local') {
          if (
            c.NODE_ENV === 'production' &&
            c.RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION !== 'true'
          )
            throw new Error('Production resumes require private S3 storage');
          return new LocalObjectStorage(
            c.RESUME_STORAGE_ROOT,
            c.RESUME_MAX_BYTES,
          );
        }
        return new S3ObjectStorage({
          endpoint: c.S3_ENDPOINT!,
          bucket: c.S3_BUCKET!,
          region: c.S3_REGION,
          accessKeyId: c.S3_ACCESS_KEY_ID!,
          secretAccessKey: c.S3_SECRET_ACCESS_KEY!,
          sessionToken: c.S3_SESSION_TOKEN,
          maxBytes: c.RESUME_MAX_BYTES,
        });
      },
    },
    {
      provide: CaptchaPort,
      useFactory: () => {
        const c = readConfig();
        return c.CAPTCHA_PROVIDER === 'turnstile'
          ? new TurnstileCaptcha({
              secretKey: c.TURNSTILE_SECRET_KEY!,
              timeoutMs: c.TURNSTILE_TIMEOUT_MS,
              expectedHostname: c.TURNSTILE_EXPECTED_HOSTNAME,
              expectedAction: c.TURNSTILE_EXPECTED_ACTION,
            })
          : new DisabledCaptcha();
      },
    },
    {
      provide: EmailPort,
      useFactory: () => {
        const c = readConfig();
        if (c.EMAIL_ADAPTER === 'smtp')
          return new SmtpEmail({
            host: c.SMTP_HOST!,
            port: c.SMTP_PORT,
            secure: c.SMTP_SECURE === 'true',
            user: c.SMTP_USER!,
            password: c.SMTP_PASSWORD!,
            from: c.SMTP_FROM!,
            publicWebBaseUrl: c.PUBLIC_WEB_BASE_URL!,
            timeoutMs: c.SMTP_TIMEOUT_MS,
          });
        return c.EMAIL_ADAPTER === 'log' && c.NODE_ENV !== 'production'
          ? new DevelopmentLogEmail()
          : new DisabledEmail();
      },
    },
    {
      provide: MalwareScanPort,
      useFactory: () => {
        const c = readConfig();
        return c.MALWARE_SCANNER === 'clamav'
          ? new ClamAvScanner({
              host: c.CLAMAV_HOST,
              port: c.CLAMAV_PORT,
              timeoutMs: c.CLAMAV_TIMEOUT_MS,
              maxBytes: c.RESUME_MAX_BYTES,
            })
          : new PendingMalwareScanner();
      },
    },
    { provide: CalendarPort, useClass: DisabledCalendar },
  ],
  exports: [
    EmailPort,
    ObjectStoragePort,
    CaptchaPort,
    MalwareScanPort,
    CalendarPort,
  ],
})
export class IntegrationsModule {}
