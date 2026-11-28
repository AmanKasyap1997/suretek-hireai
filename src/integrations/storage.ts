import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readConfig } from '../platform/config';

export interface StoredObject {
  key: string;
  versionId?: string;
}
export abstract class ObjectStoragePort {
  abstract put(
    key: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<string | undefined>;
  abstract get(key: string, versionId?: string): Promise<Buffer>;
  abstract delete(key: string, versionId?: string): Promise<void>;
}

/** Private storage for AI call recordings (larger objects than resumes). */
export abstract class CallRecordingStorage extends ObjectStoragePort {}

/** A two-channel 8 kHz WAV of the longest allowed call, plus a minute. */
export function callRecordingMaxBytes() {
  return 44 + 8000 * 4 * (readConfig().CALL_MAX_SECONDS + 60);
}

/** The deployment's private object storage, with a per-object size limit. */
export function privateStorage(maxBytes: number): ObjectStoragePort {
  const c = readConfig();
  if (c.RESUME_STORAGE === 'local') {
    if (
      c.NODE_ENV === 'production' &&
      c.RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION !== 'true'
    )
      throw new Error('Production resumes require private S3 storage');
    return new LocalObjectStorage(c.RESUME_STORAGE_ROOT, maxBytes);
  }
  return new S3ObjectStorage({
    endpoint: c.S3_ENDPOINT!,
    bucket: c.S3_BUCKET!,
    region: c.S3_REGION,
    accessKeyId: c.S3_ACCESS_KEY_ID!,
    secretAccessKey: c.S3_SECRET_ACCESS_KEY!,
    sessionToken: c.S3_SESSION_TOKEN,
    maxBytes,
  });
}

function checkedKey(key: string): string {
  if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))
    throw new Error('Invalid object key');
  return key;
}

/** Private directories only; never expose this root with static file serving. */
export class LocalObjectStorage extends ObjectStoragePort {
  private readonly root: string;
  constructor(
    root: string,
    private readonly maxBytes: number,
  ) {
    super();
    this.root = resolve(root);
  }
  private path(key: string) {
    return resolve(this.root, checkedKey(key));
  }
  async put(key: string, bytes: Buffer, contentType?: string) {
    void contentType;
    if (bytes.length > this.maxBytes)
      throw new Error('Storage size limit exceeded');
    const path = this.path(key);
    await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return undefined;
  }
  async get(key: string) {
    const path = this.path(key);
    if ((await stat(path)).size > this.maxBytes)
      throw new Error('Stored object exceeds size limit');
    return readFile(path);
  }
  async delete(key: string) {
    try {
      await unlink(this.path(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

interface S3Options {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  maxBytes: number;
}
const sha256 = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const hmac = (key: string | Buffer, value: string) =>
  createHmac('sha256', key).update(value).digest();
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/** SigV4 path-style S3 requests. No public ACLs or public URLs are produced. */
export class S3ObjectStorage extends ObjectStoragePort {
  constructor(private readonly options: S3Options) {
    super();
  }
  private async request(
    method: 'PUT' | 'GET' | 'DELETE',
    key: string,
    bytes?: Buffer,
    contentType?: string,
    versionId?: string,
  ) {
    const o = this.options;
    checkedKey(key);
    const url = new URL(
      `/${encode(o.bucket)}/${key.split('/').map(encode).join('/')}`,
      o.endpoint,
    );
    if (versionId !== undefined) url.search = `versionId=${encode(versionId)}`;
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const day = date.slice(0, 8);
    const payloadHash = sha256(bytes ?? '');
    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': date,
    };
    if (contentType) headers['content-type'] = contentType;
    if (method === 'PUT') headers['if-none-match'] = '*';
    if (o.sessionToken) headers['x-amz-security-token'] = o.sessionToken;
    const names = Object.keys(headers).sort();
    const signed = names.join(';');
    const canonical = [
      method,
      url.pathname,
      url.search.slice(1),
      names.map((name) => `${name}:${headers[name].trim()}\n`).join(''),
      signed,
      payloadHash,
    ].join('\n');
    const scope = `${day}/${o.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonical)}`;
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, day), o.region), 's3'),
      'aws4_request',
    );
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${createHmac('sha256', signingKey).update(stringToSign).digest('hex')}`;
    const response = await fetch(url, {
      method,
      headers,
      body: bytes as unknown as BodyInit | undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok && !(method === 'DELETE' && response.status === 404))
      throw new Error(`Private storage request failed (${response.status})`);
    return response;
  }
  async put(key: string, bytes: Buffer, contentType: string) {
    if (bytes.length > this.options.maxBytes)
      throw new Error('Storage size limit exceeded');
    const response = await this.request('PUT', key, bytes, contentType);
    return response.headers.get('x-amz-version-id') ?? 'null';
  }
  async get(key: string, versionId?: string) {
    const response = await this.request(
      'GET',
      key,
      undefined,
      undefined,
      versionId,
    );
    const chunks: Buffer[] = [];
    let length = 0;
    if (response.body)
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > this.options.maxBytes)
          throw new Error('Stored object exceeds size limit');
        chunks.push(Buffer.from(chunk));
      }
    return Buffer.concat(chunks);
  }
  async delete(key: string, versionId?: string) {
    await this.request(
      'DELETE',
      key,
      undefined,
      undefined,
      versionId ?? 'null',
    );
  }
}
