import nodemailer from 'nodemailer';
import {
  ContactEmail,
  EmailPort,
  InvitationEmail,
  RepeatApplicationEmail,
} from './email';
export interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  publicWebBaseUrl: string;
  timeoutMs: number;
  /** Additional trusted CA for private SMTP deployments/tests; verification stays on. */
  ca?: string;
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ]!,
  );
/** Authenticated, certificate-verified TLS, bounded send time and no provider logs. */
export class SmtpEmail extends EmailPort {
  constructor(private readonly options: SmtpOptions) {
    super();
  }
  async sendContactVerification(message: ContactEmail): Promise<boolean> {
    // The console's public confirmation page.
    const link = new URL(
      '/console/contact-verification',
      this.options.publicWebBaseUrl,
    );
    link.hash = new URLSearchParams({
      tenant: message.tenantSlug,
      token: message.token,
    }).toString();
    return this.send(
      message.to,
      'Verify your contact preferences',
      `Confirm your contact preferences: ${link.href}\nExpires: ${message.expiresAt.toISOString()}\nIf you did not apply, ignore this email.`,
      `<p>Confirm your contact preferences:</p><p><a href="${escape(link.href)}">Verify contact preferences</a></p><p>Expires: ${escape(message.expiresAt.toISOString())}</p><p>If you did not apply, ignore this email.</p>`,
    );
  }
  async sendInvitation(message: InvitationEmail): Promise<boolean> {
    const link = new URL(
      '/console/accept-invitation',
      this.options.publicWebBaseUrl,
    );
    // Fragments never reach HTTP access logs or Referer headers. No email in URL.
    link.hash = new URLSearchParams({
      organization: message.organizationSlug,
      token: message.token,
    }).toString();
    const role =
      message.role === 'HR_ADMIN'
        ? 'Organization Admin'
        : message.role.toLowerCase().replaceAll('_', ' ');
    return this.send(
      message.to,
      `You're invited to ${message.organizationName} on Suretek HireAI`,
      `Hello ${message.fullName},\nYou have been invited to ${message.organizationName} as ${role}.\nSet your password: ${link.href}\nOrganization sign-in key: ${message.organizationSlug}\nExpires: ${message.expiresAt.toISOString()}\nThis link can only be used once. If you did not expect this invitation, ignore it.`,
      `<p>Hello ${escape(message.fullName)},</p><p>You have been invited to <strong>${escape(message.organizationName)}</strong> as ${escape(role)}.</p><p><a href="${escape(link.href)}">Accept invitation and set password</a></p><p>Organization sign-in key: <strong>${escape(message.organizationSlug)}</strong></p><p>Expires: ${escape(message.expiresAt.toISOString())}</p><p>This link can only be used once. If you did not expect this invitation, ignore it.</p>`,
    );
  }
  async sendRepeatApplication(
    message: RepeatApplicationEmail,
  ): Promise<boolean> {
    const date = new Intl.DateTimeFormat('en-GB', {
      dateStyle: 'long',
      timeZone: 'UTC',
    }).format(message.appliedAt);
    return this.send(
      message.to,
      `You've already applied to ${message.organizationName}`,
      `You've already applied for ${message.jobTitle} at ${message.organizationName}, on ${date}.\nWe received another application for this job from this email address and didn't save it. Your first application is unchanged.\nIf you didn't apply again, you can ignore this email.`,
      `<p>You've already applied for <strong>${escape(message.jobTitle)}</strong> at ${escape(message.organizationName)}, on ${escape(date)}.</p><p>We received another application for this job from this email address and didn't save it. Your first application is unchanged.</p><p>If you didn't apply again, you can ignore this email.</p>`,
    );
  }
  private async send(
    to: string,
    subject: string,
    text: string,
    html: string,
  ): Promise<boolean> {
    const o = this.options;
    const transport = nodemailer.createTransport({
      host: o.host,
      port: o.port,
      secure: o.secure,
      requireTLS: true,
      forceAuth: true,
      auth: { user: o.user, pass: o.password },
      connectionTimeout: o.timeoutMs,
      greetingTimeout: o.timeoutMs,
      socketTimeout: o.timeoutMs,
      tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true, ca: o.ca },
      logger: false,
      debug: false,
    });
    try {
      const result = await transport.sendMail({
        signal: AbortSignal.timeout(o.timeoutMs),
        from: o.from,
        to,
        subject,
        text,
        html,
      });
      return result.accepted.length > 0;
    } catch {
      return false;
    } finally {
      transport.close();
    }
  }
}
