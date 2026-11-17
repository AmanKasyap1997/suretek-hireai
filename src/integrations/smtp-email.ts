import nodemailer from 'nodemailer';
import { ContactEmail, EmailPort } from './email';

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

/** One authenticated TLS connection per message; no unbounded pool or provider logs. */
export class SmtpEmail extends EmailPort {
  constructor(private readonly options: SmtpOptions) {
    super();
  }
  async sendContactVerification(message: ContactEmail): Promise<boolean> {
    const o = this.options;
    const options = {
      host: o.host,
      port: o.port,
      secure: o.secure,
      requireTLS: true,
      forceAuth: true,
      auth: { user: o.user, pass: o.password },
      connectionTimeout: o.timeoutMs,
      greetingTimeout: o.timeoutMs,
      socketTimeout: o.timeoutMs,
      tls: {
        minVersion: 'TLSv1.2' as const,
        rejectUnauthorized: true,
        ca: o.ca,
      },
      logger: false,
      debug: false,
    };
    const transport = nodemailer.createTransport(options);
    // Fragment keeps the token out of HTTP access logs and Referer headers.
    // A future web client must read it and POST the token to the existing API.
    const link = new URL('/contact-verification', o.publicWebBaseUrl);
    link.hash = new URLSearchParams({
      tenant: message.tenantSlug,
      token: message.token,
    }).toString();
    const escape = (s: string) =>
      s.replace(
        /[&<>"']/g,
        (c) =>
          ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
          })[c]!,
      );
    try {
      // Nodemailer >=10 natively aborts the in-flight socket, including DATA.
      const mail = {
        signal: AbortSignal.timeout(o.timeoutMs),
        from: o.from,
        to: message.to,
        subject: 'Verify your contact preferences',
        text: `Confirm your contact preferences: ${link.href}\nExpires: ${message.expiresAt.toISOString()}\nIf you did not apply, ignore this email.`,
        html: `<p>Confirm your contact preferences:</p><p><a href="${escape(link.href)}">Verify contact preferences</a></p><p>Expires: ${escape(message.expiresAt.toISOString())}</p><p>If you did not apply, ignore this email.</p>`,
      };
      const result = await transport.sendMail(mail);
      return result.accepted.length > 0;
    } catch {
      // SMTP errors may include full addresses, credentials or provider responses.
      return false;
    } finally {
      transport.close();
    }
  }
}
