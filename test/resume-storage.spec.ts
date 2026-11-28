import { intakeSchema } from '../src/modules/talent-acquisition';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LocalObjectStorage,
  S3ObjectStorage,
  validateResume,
  DisabledCaptcha,
  PendingMalwareScanner,
} from '../src/integrations';
import { DocumentScanStatus } from '../src/shared/enums';
import { docxResume, pdfResume } from './helpers/resume';

it('validates PDF and DOCX signatures, names, package structure and byte limits', () => {
  expect(validateResume('../unsafe name.pdf', pdfResume, 10000)).toEqual({
    filename: 'unsafe_name.pdf',
    contentType: 'application/pdf',
  });
  expect(
    validateResume('resume.docx', docxResume(), 10000).contentType,
  ).toContain('wordprocessingml');
  expect(() => validateResume('resume.pdf', pdfResume, 4)).toThrow(
    /size limit/,
  );
  expect(() => validateResume('resume.exe', pdfResume, 10000)).toThrow(
    /Only valid/,
  );
  expect(() =>
    validateResume('resume.pdf', Buffer.from('fake PDF'), 10000),
  ).toThrow(/Only valid/);
  expect(() =>
    validateResume('resume.docx', Buffer.from('PK arbitrary ZIP'), 10000),
  ).toThrow(/Only valid/);
  expect(() =>
    validateResume(
      'resume.docx',
      docxResume([
        '[Content_Types].xml',
        '_rels/.rels',
        '../word/document.xml',
      ]),
      10000,
    ),
  ).toThrow(/Only valid/);
  const corrupt = docxResume();
  corrupt.writeUInt32LE(0xffffffff, corrupt.length - 6);
  expect(() => validateResume('resume.docx', corrupt, 10000)).toThrow(
    /Only valid/,
  );
});
it('enforces the decoded public resume limit at the base64 padding boundary', () => {
  const input = {
    fullName: 'Public applicant',
    email: 'test@example.test',
    phone: '+919876543210',
    currentLocation: 'Noida',
    totalExperienceMonths: 12,
    noticePeriod: 'IMMEDIATE',
    expectedCtc: 600000,
    privacyAccepted: true,
    noticeVersion: '2026-11-v1',
    resume: {
      filename: 'resume.pdf',
      base64: Buffer.alloc(512 * 1024).toString('base64'),
    },
  };
  expect(intakeSchema.safeParse(input).success).toBe(true);
  expect(
    intakeSchema.safeParse({
      ...input,
      resume: {
        ...input.resume,
        base64: Buffer.alloc(512 * 1024 + 1).toString('base64'),
      },
    }).success,
  ).toBe(false);
});
it('rejects corrupt DOCX entries, inconsistent ZIP headers and forged expansion sizes', () => {
  const valid = docxResume(undefined, true);
  expect(validateResume('resume.docx', valid, 10000).contentType).toContain(
    'wordprocessingml',
  );
  const corrupt = docxResume();
  const dataStart = 30 + corrupt.readUInt16LE(26) + corrupt.readUInt16LE(28);
  corrupt[dataStart] ^= 1;
  expect(() => validateResume('resume.docx', corrupt, 10000)).toThrow(
    /Only valid/,
  );
  const inconsistent = docxResume();
  inconsistent.writeUInt16LE(8, 8);
  expect(() => validateResume('resume.docx', inconsistent, 10000)).toThrow(
    /Only valid/,
  );
  const overExpanding = docxResume(undefined, true);
  const directory = overExpanding.readUInt32LE(overExpanding.length - 6);
  overExpanding.writeUInt32LE(1, 22);
  overExpanding.writeUInt32LE(1, directory + 24);
  expect(() => validateResume('resume.docx', overExpanding, 10000)).toThrow(
    /Only valid/,
  );
});
it('uses explicit disabled CAPTCHA and a fail-closed scanner stub', async () => {
  expect(await new DisabledCaptcha().verify()).toBe(true);
  expect(await new PendingMalwareScanner().scan()).toBe(
    DocumentScanStatus.PENDING,
  );
});
it('keeps local objects private, bounds reads and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hireai-storage-')),
    key = `${randomUUID()}/${randomUUID()}`;
  try {
    const storage = new LocalObjectStorage(root, 10000);
    await storage.put(key, pdfResume, 'application/pdf');
    expect(await storage.get(key)).toEqual(pdfResume);
    expect((await stat(join(root, key))).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, key, '..'))).mode & 0o777).toBe(0o700);
    await expect(storage.get('../secret')).rejects.toThrow(
      /Invalid object key/,
    );
    await expect(storage.put(key, pdfResume)).rejects.toMatchObject({
      code: 'EEXIST',
    });
    await storage.delete(key);
    await storage.delete(key);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('S3-compatible signed storage protocol', () => {
  let server: Server, endpoint: string;
  const objects = new Map<string, Buffer>();
  const hmac = (key: string | Buffer, value: string) =>
    createHmac('sha256', key).update(value).digest();
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      const authorization = req.headers.authorization ?? '';
      const names =
        authorization.match(/SignedHeaders=([^,]+)/)?.[1].split(';') ?? [];
      const date = String(req.headers['x-amz-date']),
        day = date.slice(0, 8),
        scope = `${day}/us-east-1/s3/aws4_request`;
      const requestUrl = new URL(req.url!, endpoint);
      const canonical = [
        req.method,
        requestUrl.pathname,
        requestUrl.search.slice(1),
        names
          .map((name) => `${name}:${String(req.headers[name]).trim()}\n`)
          .join(''),
        names.join(';'),
        createHash('sha256').update(bytes).digest('hex'),
      ].join('\n');
      const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${createHash('sha256').update(canonical).digest('hex')}`;
      const signature = createHmac(
        'sha256',
        hmac(
          hmac(hmac(hmac('AWS4test-secret', day), 'us-east-1'), 's3'),
          'aws4_request',
        ),
      )
        .update(stringToSign)
        .digest('hex');
      if (
        !authorization.endsWith(signature) ||
        req.headers['x-amz-acl'] ||
        req.headers['x-amz-security-token'] !== 'temporary-session'
      ) {
        res.writeHead(403).end();
        return;
      }
      if (
        req.method !== 'PUT' &&
        requestUrl.searchParams.get('versionId') !== 'test-version-1'
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === 'PUT') {
        objects.set(requestUrl.pathname, bytes);
        res.writeHead(200, { 'x-amz-version-id': 'test-version-1' }).end();
      } else if (req.method === 'GET') {
        const value = objects.get(requestUrl.pathname);
        if (value) res.end(value);
        else res.writeHead(404).end();
      } else if (req.method === 'DELETE') {
        objects.delete(requestUrl.pathname);
        res.writeHead(204).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  it('round-trips private objects using verified SigV4 and propagates missing-object failures', async () => {
    const storage = new S3ObjectStorage({
      endpoint,
      bucket: 'private-resumes',
      region: 'us-east-1',
      accessKeyId: 'test-key',
      secretAccessKey: 'test-secret',
      sessionToken: 'temporary-session',
      maxBytes: 10000,
    });
    const key = `${randomUUID()}/${randomUUID()}`;
    const version = await storage.put(key, pdfResume, 'application/pdf');
    expect(version).toBe('test-version-1');
    expect(await storage.get(key, version)).toEqual(pdfResume);
    await storage.delete(key, version);
    await storage.delete(key, version);
    await expect(storage.get(key, version)).rejects.toThrow(/404/);
    await expect(storage.get('../file')).rejects.toThrow(/Invalid object key/);
  });
});
