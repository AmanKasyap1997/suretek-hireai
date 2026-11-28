import { Logger } from '@nestjs/common';
export interface ContactEmail {
  to: string;
  tenantSlug: string;
  token: string;
  expiresAt: Date;
}
export interface InvitationEmail {
  to: string;
  fullName: string;
  organizationName: string;
  organizationSlug: string;
  role: string;
  token: string;
  expiresAt: Date;
}
/** Sent when someone applies again to a job this email address already applied to. */
export interface RepeatApplicationEmail {
  to: string;
  organizationName: string;
  jobTitle: string;
  appliedAt: Date;
}
export abstract class EmailPort {
  abstract sendContactVerification(message: ContactEmail): Promise<boolean>;
  abstract sendInvitation(message: InvitationEmail): Promise<boolean>;
  abstract sendRepeatApplication(
    message: RepeatApplicationEmail,
  ): Promise<boolean>;
}
/** Development only: tokens are deliberately visible to the local developer. */
export class DevelopmentLogEmail extends EmailPort {
  // Invitations require an SMTP adapter, including a local mail catcher in dev.
  // Never print invitation secrets or recipient details to application logs.
  async sendInvitation() {
    return false;
  }
  async sendContactVerification(message: ContactEmail) {
    if (process.env.NODE_ENV === 'production') return false;
    new Logger('DevelopmentEmail').log(JSON.stringify(message));
    return true;
  }
  // No recipient in the log: only that the notice would have been sent.
  async sendRepeatApplication(message: RepeatApplicationEmail) {
    if (process.env.NODE_ENV === 'production') return false;
    new Logger('DevelopmentEmail').log(
      `Repeat-application email for "${message.jobTitle}"`,
    );
    return true;
  }
}
/** No production provider is included. Never log production verification secrets. */
export class DisabledEmail extends EmailPort {
  async sendInvitation() {
    return false;
  }
  async sendContactVerification() {
    return false;
  }
  async sendRepeatApplication() {
    return false;
  }
}
