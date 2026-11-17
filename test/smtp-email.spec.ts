import { SMTPServer } from 'smtp-server';
import { createServer, Server } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SmtpEmail, SmtpOptions } from '../src/integrations/smtp-email';

describe('SMTP EmailPort with a fake TLS SMTP server', () => {
  let dir: string;
  let cert: string;
  let key: string;
  const servers: Array<SMTPServer | Server> = [];
  const message = {
    to: 'controlled@example.test',
    tenantSlug: 'pilot',
    token: 'test-secret-token',
    expiresAt: new Date('2030-01-01T00:00:00Z'),
  };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hireai-smtp-'));
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        join(dir, 'key'),
        '-out',
        join(dir, 'cert'),
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost,IP:127.0.0.1',
      ],
      { stdio: 'ignore' },
    );
    cert = readFileSync(join(dir, 'cert'), 'utf8');
    key = readFileSync(join(dir, 'key'), 'utf8');
  });
  afterEach(async () => {
    await Promise.all(
      servers
        .splice(0)
        .map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  async function start(options: ConstructorParameters<typeof SMTPServer>[0]) {
    const server = new SMTPServer({
      key,
      cert,
      logger: false,
      closeTimeout: 1000,
      ...options,
    });
    servers.push(server);
    server.on('error', () => undefined);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    return (server.server.address() as { port: number }).port;
  }
  function adapter(port: number, extra: Partial<SmtpOptions> = {}) {
    return new SmtpEmail({
      host: '127.0.0.1',
      port,
      secure: true,
      user: 'test-user',
      password: 'test-password',
      from: 'verify@example.test',
      publicWebBaseUrl: 'https://careers.example.test',
      timeoutMs: 2000,
      ca: cert,
      ...extra,
    });
  }
  it.each([true, false])(
    'authenticates over TLS (implicit=%s) and sends text plus HTML without query tokens',
    async (secure) => {
      let raw = '';
      let authenticated = false;
      const port = await start({
        secure,
        onAuth(auth, session, callback) {
          authenticated =
            session.secure &&
            auth.username === 'test-user' &&
            auth.password === 'test-password';
          callback(null, { user: auth.username });
        },
        onData(stream, _session, callback) {
          stream.on('data', (chunk) => {
            raw += chunk.toString();
          });
          stream.on('end', () => callback());
        },
      });
      expect(
        await adapter(port, { secure }).sendContactVerification(message),
      ).toBe(true);
      expect(authenticated).toBe(true);
      expect(raw).toContain('multipart/alternative');
      expect(raw).toContain('text/plain');
      expect(raw).toContain('text/html');
      expect(raw.replace(/=\r\n/g, '').replace(/=3D/g, '=')).toContain(
        '/contact-verification#tenant=pilot&token=test-secret-token',
      );
      expect(raw).not.toContain('?token=');
    },
  );
  it('refuses plaintext SMTP without STARTTLS', async () => {
    const port = await start({
      disabledCommands: ['STARTTLS'],
      authOptional: true,
    });
    expect(
      await adapter(port, { secure: false }).sendContactVerification(message),
    ).toBe(false);
  });
  it('delivers escaped invitation mail over authenticated TLS with a one-time fragment link', async () => {
    let raw = '';
    const port = await start({
      secure: true,
      onAuth(_auth, _session, callback) {
        callback(null, { user: 'test' });
      },
      onData(stream, _session, callback) {
        stream.on('data', (chunk) => {
          raw += chunk.toString();
        });
        stream.on('end', () => callback());
      },
    });
    expect(
      await adapter(port).sendInvitation({
        to: 'invited@example.test',
        fullName: '<Invited Admin>',
        organizationName: '<Acme & Co>',
        organizationSlug: 'acme',
        role: 'HR_ADMIN',
        token: 'a'.repeat(43),
        expiresAt: new Date('2030-01-01T00:00:00Z'),
      }),
    ).toBe(true);
    const decoded = raw.replace(/=\r\n/g, '').replace(/=3D/g, '=');
    expect(decoded).toContain(
      '/console/accept-invitation#organization=acme&token=',
    );
    expect(decoded).toContain('&lt;Acme &amp; Co&gt;');
    expect(decoded).toContain('Organization Admin');
    expect(decoded).not.toContain('?token=');
    expect(decoded).not.toContain('test-password');
  });
  it('refuses a server that cannot authenticate even over TLS', async () => {
    const port = await start({
      secure: true,
      disabledCommands: ['AUTH'],
      authOptional: true,
    });
    expect(await adapter(port).sendContactVerification(message)).toBe(false);
  });
  it('rejects an untrusted TLS certificate', async () => {
    const port = await start({ secure: true });
    expect(
      await adapter(port, { ca: undefined }).sendContactVerification(message),
    ).toBe(false);
  });
  it('returns false for authentication and delivery rejection without leaking errors', async () => {
    const port = await start({
      secure: true,
      onAuth(_auth, _session, callback) {
        callback(new Error('sensitive provider response'));
      },
    });
    expect(await adapter(port).sendContactVerification(message)).toBe(false);
    const rejected = await start({
      secure: true,
      onAuth(_auth, _session, cb) {
        cb(null, { user: 'test' });
      },
      onRcptTo(_address, _session, cb) {
        cb(new Error('rejected recipient'));
      },
    });
    expect(await adapter(rejected).sendContactVerification(message)).toBe(
      false,
    );
  });
  it('bounds the total send deadline when the SMTP DATA reply stalls', async () => {
    const port = await start({
      secure: true,
      onAuth(_a, _s, cb) {
        cb(null, { user: 'test' });
      },
      onData(stream) {
        stream.resume();
      },
    });
    const started = Date.now();
    expect(
      await adapter(port, { timeoutMs: 300 }).sendContactVerification(message),
    ).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });
  it('bounds connection/greeting timeouts', async () => {
    const server = createServer((socket) => {
      socket.on('error', () => undefined);
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    expect(
      await adapter((server.address() as { port: number }).port, {
        secure: false,
        timeoutMs: 200,
      }).sendContactVerification(message),
    ).toBe(false);
  });
});
