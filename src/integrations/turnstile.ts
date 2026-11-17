import { CaptchaPort } from './intake';
export class TurnstileCaptcha extends CaptchaPort {
  constructor(
    private readonly options: {
      secretKey: string;
      timeoutMs: number;
      expectedHostname?: string;
      expectedAction?: string;
    },
  ) {
    super();
  }
  async verify(token: string | undefined, ip: string): Promise<boolean> {
    if (!token || token.length > 2048) return false;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), this.options.timeoutMs);
    try {
      const response = await fetch(
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
        {
          method: 'POST',
          redirect: 'error',
          signal: abort.signal,
          body: new URLSearchParams({
            secret: this.options.secretKey,
            response: token,
            remoteip: ip,
          }),
        },
      );
      if (!response.ok || !response.body) return false;
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8192) {
          await reader.cancel();
          return false;
        }
        chunks.push(value);
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return (
        result.success === true &&
        (!this.options.expectedHostname ||
          result.hostname === this.options.expectedHostname) &&
        (!this.options.expectedAction ||
          result.action === this.options.expectedAction)
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
