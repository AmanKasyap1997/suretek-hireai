import 'reflect-metadata';
import { Controller, Get, INestApplication, Module, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { readConfig } from '../src/common/config';

@Controller('probe')
class ProbeController {
  @Get('ip')
  ip(@Req() req: Request) {
    return { ip: req.ip };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('Production configuration', () => {
  const originalEnv = process.env;
  let app: INestApplication | undefined;

  beforeEach(() => {
    process.env = {
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://runtime:password@localhost:5432/hireai',
      JWT_SECRET: 'a-test-only-secret-with-at-least-thirty-two-characters',
    };
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    process.env = originalEnv;
  });

  async function createApp() {
    app = await NestFactory.create(ProbeModule, { logger: false });
    configureApp(app);
    await app.init();
    return app;
  }

  it('disables Swagger UI and JSON by default in production', async () => {
    const configured = await createApp();
    expect(readConfig().SWAGGER_ENABLED).toBe(false);
    await request(configured.getHttpServer()).get('/docs').expect(404);
    await request(configured.getHttpServer()).get('/docs-json').expect(404);
  });

  it('allows an explicit Swagger opt-in in production', async () => {
    process.env.SWAGGER_ENABLED = 'true';
    const configured = await createApp();
    await request(configured.getHttpServer()).get('/docs').expect(200);
    const response = await request(configured.getHttpServer())
      .get('/docs-json')
      .expect(200);
    expect(response.body.paths['/api/v1/probe/ip']).toBeDefined();
  });

  it('enables Swagger by default in development', async () => {
    process.env.NODE_ENV = 'development';
    const configured = await createApp();
    await request(configured.getHttpServer()).get('/docs-json').expect(200);
  });

  it('honors an explicit Swagger opt-out in development', async () => {
    process.env.NODE_ENV = 'development';
    process.env.SWAGGER_ENABLED = 'false';
    const configured = await createApp();
    await request(configured.getHttpServer()).get('/docs').expect(404);
    await request(configured.getHttpServer()).get('/docs-json').expect(404);
  });

  it.each(['TRUE', 'False', 'yes', '1', '', ' true '])(
    'rejects invalid SWAGGER_ENABLED=%j',
    (value) => {
      process.env.SWAGGER_ENABLED = value;
      expect(() => readConfig()).toThrow(/SWAGGER_ENABLED/);
    },
  );

  it('does not trust forwarded client IPs by default', async () => {
    const configured = await createApp();
    expect(configured.getHttpAdapter().getInstance().get('trust proxy')).toBe(
      false,
    );
    const response = await request(configured.getHttpServer())
      .get('/api/v1/probe/ip')
      .set('X-Forwarded-For', '203.0.113.9')
      .expect(200);
    expect(response.body.ip).not.toBe('203.0.113.9');
  });

  it.each([
    ['0', 0, undefined],
    ['1', 1, '198.51.100.7'],
    ['2', 2, '203.0.113.9'],
  ] as const)(
    'applies TRUST_PROXY=%s as an exact hop count',
    async (value, hops, expectedIp) => {
      process.env.TRUST_PROXY = value;
      const configured = await createApp();
      expect(configured.getHttpAdapter().getInstance().get('trust proxy')).toBe(
        hops,
      );
      const response = await request(configured.getHttpServer())
        .get('/api/v1/probe/ip')
        .set('X-Forwarded-For', '203.0.113.9, 198.51.100.7')
        .expect(200);
      if (expectedIp) expect(response.body.ip).toBe(expectedIp);
      else
        expect(response.body.ip).not.toMatch(/203\.0\.113\.9|198\.51\.100\.7/);
    },
  );

  it.each([
    'true',
    'TRUE',
    'all',
    '-1',
    '1.5',
    '1e2',
    '',
    '01',
    ' 1',
    'Infinity',
    '9999999999999999999999',
  ])('rejects invalid TRUST_PROXY=%j', (value) => {
    process.env.TRUST_PROXY = value;
    expect(() => readConfig()).toThrow(/TRUST_PROXY/);
  });

  it('does not require migration owner credentials in the production API', () => {
    expect(readConfig().DATABASE_MIGRATION_URL).toBeUndefined();
  });

  it('validates an optional migration connection URL', () => {
    process.env.DATABASE_MIGRATION_URL =
      'postgresql://owner:password@localhost:5432/hireai';
    expect(readConfig().DATABASE_MIGRATION_URL).toBe(
      process.env.DATABASE_MIGRATION_URL,
    );
    process.env.DATABASE_MIGRATION_URL = 'https://database.example.com';
    expect(() => readConfig()).toThrow(/DATABASE_MIGRATION_URL/);
  });
});
