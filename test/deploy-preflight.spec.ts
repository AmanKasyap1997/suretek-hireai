import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  chmodSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

describe('production deployment preflight', () => {
  let dir: string;
  let cfg: Record<string, string>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hireai-preflight-'));
    cfg = {
      DOMAIN: 'careers.suretek.test',
      ACME_EMAIL: 'ops@suretek.test',
      IMAGE_TAG: 'v1.2.3',
      JWT_SECRET: 'a'.repeat(64),
      POSTGRES_ADMIN_PASSWORD: 'b'.repeat(64),
      HIREAI_OWNER_PASSWORD: 'c'.repeat(64),
      HIREAI_APP_PASSWORD: 'd'.repeat(64),
      MALWARE_SCANNER: 'clamav',
      CAPTCHA_PROVIDER: 'turnstile',
      TURNSTILE_SECRET_KEY: 'test-key',
      EMAIL_ADAPTER: 'smtp',
      SMTP_HOST: 'smtp.suretek.test',
      SMTP_USER: 'pilot',
      SMTP_PASSWORD: 'test-smtp-secret',
      SMTP_FROM: 'verify@suretek.test',
      PUBLIC_WEB_BASE_URL: 'https://careers.suretek.test',
      CORS_ORIGINS: 'https://careers.suretek.test',
      BACKUP_AGE_RECIPIENT: 'age1' + 'a'.repeat(58),
      BACKUP_RSYNC_DEST: 'backup@offsite.test:/backups/hireai/',
      TENANT_ID: '10000000-0000-4000-8000-000000000001',
      MAINTENANCE_ACTOR_ID: '10000000-0000-4000-8000-000000000002',
      RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION: 'true',
      TRUST_PROXY: '1',
      STATE_DIR: join(dir, 'state'),
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  function run(mode = 0o600) {
    const file = join(dir, '.env');
    writeFileSync(
      file,
      Object.entries(cfg)
        .map(([k, v]) => `${k}='${v}'`)
        .join('\n'),
      { mode },
    );
    chmodSync(file, mode);
    return spawnSync('bash', [resolve('deploy/preflight.sh')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, ENV_FILE: file },
    });
  }
  it('accepts complete pilot configuration', () => {
    expect(run().status).toBe(0);
  });
  it.each([
    'DOMAIN',
    'JWT_SECRET',
    'MALWARE_SCANNER',
    'TURNSTILE_SECRET_KEY',
    'SMTP_HOST',
    'SMTP_PASSWORD',
    'BACKUP_AGE_RECIPIENT',
    'BACKUP_RSYNC_DEST',
    'TENANT_ID',
    'MAINTENANCE_ACTOR_ID',
  ])('refuses missing %s', (key) => {
    delete cfg[key];
    expect(run().status).not.toBe(0);
  });
  it.each([
    ['POSTGRES_ADMIN_PASSWORD', 'postgres_dev_only'],
    ['HIREAI_APP_PASSWORD', 'hireai_app_dev_only'],
    ['JWT_SECRET', 'short'],
    ['MALWARE_SCANNER', 'pending'],
    ['CAPTCHA_PROVIDER', 'disabled'],
    ['EMAIL_ADAPTER', 'log'],
    ['CORS_ORIGINS', '*'],
    ['CORS_ORIGINS', 'https://careers.suretek.test/path'],
    ['PUBLIC_WEB_BASE_URL', 'http://careers.suretek.test'],
    ['IMAGE_TAG', 'latest'],
    ['BACKUP_RETENTION_DAYS', '0'],
    ['BACKUP_RSYNC_DEST', '/local/only'],
    ['TRUST_PROXY', 'false'],
    ['RESUME_STORAGE_ALLOW_LOCAL_IN_PRODUCTION', 'false'],
  ])('refuses unsafe %s=%s', (key, value) => {
    cfg[key] = value;
    expect(run().status).not.toBe(0);
  });
  it('refuses a readable-by-others env file', () => {
    expect(run(0o644).status).not.toBe(0);
  });
  it('generates unique strong secrets in mode 600 and refuses overwrite', () => {
    const file = join(dir, 'generated');
    const script = resolve('deploy/generate-secrets.sh');
    expect(spawnSync('bash', [script, file]).status).toBe(0);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const secrets = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) =>
        /^(JWT_SECRET|POSTGRES_ADMIN_PASSWORD|HIREAI_OWNER_PASSWORD|HIREAI_APP_PASSWORD)=/.test(
          line,
        ),
      )
      .map((line) => line.split('=')[1]);
    expect(secrets).toHaveLength(4);
    expect(new Set(secrets).size).toBe(4);
    secrets.forEach((secret) => expect(secret).toMatch(/^[0-9a-f]{64}$/));
    expect(spawnSync('bash', [script, file]).status).not.toBe(0);
  });
});
