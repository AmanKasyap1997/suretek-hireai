import { Logger } from '@nestjs/common';
export interface ContactEmail {
  to: string;
  tenantSlug: string;
  token: string;
  expiresAt: Date;
}
export abstract class EmailPort {
  abstract sendContactVerification(message: ContactEmail): Promise<boolean>;
}
/** Development only: tokens are deliberately visible to the local developer. */
export class DevelopmentLogEmail extends EmailPort {
  async sendContactVerification(message: ContactEmail) {
    if (process.env.NODE_ENV === 'production') return false;
    new Logger('DevelopmentEmail').log(JSON.stringify(message));
    return true;
  }
}
/** No production provider is included. Never log production verification secrets. */
export class DisabledEmail extends EmailPort {
  async sendContactVerification() {
    return false;
  }
}
