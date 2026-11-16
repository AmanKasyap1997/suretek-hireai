import { DocumentScanStatus } from '../shared/enums';
export abstract class CaptchaPort {
  abstract verify(token: string | undefined, ip: string): Promise<boolean>;
}
/** Explicitly disabled. Deploy a real adapter before enabling CAPTCHA. */
export class DisabledCaptcha extends CaptchaPort {
  async verify() {
    return true;
  }
}
export abstract class MalwareScanPort {
  abstract scan(bytes: Buffer): Promise<DocumentScanStatus>;
}
/** No scanning capability: never claims a document is safe. */
export class PendingMalwareScanner extends MalwareScanPort {
  async scan() {
    return DocumentScanStatus.PENDING;
  }
}
