import { randomUUID } from 'node:crypto';
import { S3ObjectStorage } from '../src/integrations';
it('round trips a private object through real MinIO, deletes it and rejects missing reads', async () => {
  if (!process.env.MINIO_TEST_ENDPOINT)
    throw new Error(
      'Start Compose readiness MinIO and set MINIO_TEST_ENDPOINT=http://127.0.0.1:9000',
    );
  const storage = new S3ObjectStorage({
    endpoint: process.env.MINIO_TEST_ENDPOINT,
    bucket: 'private-resumes',
    region: 'us-east-1',
    accessKeyId: 'hireai_dev',
    secretAccessKey: 'hireai_minio_dev_only',
    maxBytes: 1024,
  });
  const key = `${randomUUID()}/${randomUUID()}`,
    bytes = Buffer.from('private round trip');
  const version = await storage.put(key, bytes, 'application/pdf');
  try {
    expect(await storage.get(key, version)).toEqual(bytes);
    await expect(storage.put(key, bytes, 'application/pdf')).rejects.toThrow();
  } finally {
    await storage.delete(key, version);
  }
  await expect(storage.get(key, version)).rejects.toThrow(/404/);
  await storage.delete(key, version);
});
