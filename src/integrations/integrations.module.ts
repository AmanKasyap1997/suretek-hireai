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
@Module({
  providers: [
    {
      provide: ObjectStoragePort,
      useFactory: () => {
        const c = readConfig();
        if (c.RESUME_STORAGE === 'local') {
          if (c.NODE_ENV === 'production')
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
    { provide: CaptchaPort, useClass: DisabledCaptcha },
    { provide: MalwareScanPort, useClass: PendingMalwareScanner },
  ],
  exports: [ObjectStoragePort, CaptchaPort, MalwareScanPort],
})
export class IntegrationsModule {}
