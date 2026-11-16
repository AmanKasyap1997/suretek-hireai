import 'reflect-metadata';
import { INestApplication, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  MetadataScanner,
  ModulesContainer,
  NestFactory,
  Reflector,
} from '@nestjs/core';
import { ApplicationConfig } from '@nestjs/core/application-config';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { PUBLIC_KEY, ROLES_KEY } from '../src/auth/roles.decorator';
import { Role } from '../src/common/enums';

interface RouteContract {
  method: string;
  path: string;
  public: boolean;
  roles: Role[];
}

interface ExpressLayer {
  route?: {
    path: unknown;
    methods: Record<string, boolean>;
  };
  handle?: { stack?: ExpressLayer[] };
}

function paths(value: unknown): string[] {
  const result = Array.isArray(value) ? value : [value];
  if (result.some((path) => typeof path !== 'string')) {
    throw new Error('Route inventory requires string route paths');
  }
  return result as string[];
}

function fullPath(...parts: string[]): string {
  return `/${parts
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')}`;
}

function nestContracts(app: INestApplication): Map<string, RouteContract> {
  const scanner = new MetadataScanner();
  const reflector = app.get(Reflector);
  const modules = app.get(ModulesContainer);
  const prefix = (
    app as unknown as { config: ApplicationConfig }
  ).config.getGlobalPrefix();
  const contracts = new Map<string, RouteContract>();
  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const controller = wrapper.metatype;
      const instance = wrapper.instance as Record<string, unknown> | undefined;
      if (!controller || !instance) continue;
      const controllerPaths = paths(
        Reflect.getMetadata(PATH_METADATA, controller) ?? '',
      );
      for (const name of scanner.getAllMethodNames(
        Object.getPrototypeOf(instance),
      )) {
        const handler = instance[name];
        if (typeof handler !== 'function') continue;
        const requestMethod = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (requestMethod === undefined) continue;
        const methodPaths = paths(
          Reflect.getMetadata(PATH_METADATA, handler) ?? '',
        );
        const isPublic =
          reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
            handler,
            controller,
          ]) === true;
        const roles = [
          ...(reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
            handler,
            controller,
          ]) ?? []),
        ].sort();
        for (const controllerPath of controllerPaths) {
          for (const methodPath of methodPaths) {
            const path = fullPath(prefix, controllerPath, methodPath);
            const method = RequestMethod[requestMethod];
            const key = `${method} ${path}`;
            if (contracts.has(key))
              throw new Error(`Duplicate Nest route metadata: ${key}`);
            contracts.set(key, { method, path, public: isPublic, roles });
          }
        }
      }
    }
  }
  return contracts;
}

function registeredContracts(app: INestApplication): RouteContract[] {
  const metadata = nestContracts(app);
  const matched = new Set<string>();
  const express = app.getHttpAdapter().getInstance() as {
    router: { stack: ExpressLayer[] };
  };
  const swaggerPaths = new Set([
    '/docs',
    '/docs/',
    '/docs/index.html',
    '/docs/LICENSE',
    '/docs/swagger-ui-init.js',
    '/docs/docs/swagger-ui-init.js',
    '/docs-json',
    '/docs-yaml',
  ]);
  const result: RouteContract[] = [];
  for (const layer of express.router.stack) {
    if (layer.handle?.stack) {
      throw new Error(
        'Nested Express router requires explicit route-prefix resolution',
      );
    }
    if (!layer.route) continue;
    for (const path of paths(layer.route.path)) {
      for (const [registeredMethod, enabled] of Object.entries(
        layer.route.methods,
      )) {
        if (!enabled) continue;
        const method =
          registeredMethod === '_all' ? 'ALL' : registeredMethod.toUpperCase();
        const key = `${method} ${path}`;
        const controllerContract =
          metadata.get(key) ?? metadata.get(`ALL ${path}`);
        if (controllerContract) {
          matched.add(
            `${controllerContract.method} ${controllerContract.path}`,
          );
          result.push({ ...controllerContract, method });
        } else if (method === 'GET' && swaggerPaths.has(path)) {
          // Swagger registers Express handlers directly, outside Nest's guards.
          result.push({ method, path, public: true, roles: [] });
        } else {
          throw new Error(
            `Registered route has no controller access metadata: ${key}`,
          );
        }
      }
    }
  }
  const missing = [...metadata.keys()].filter((key) => !matched.has(key));
  if (missing.length)
    throw new Error(
      `Controller routes were not registered: ${missing.join(', ')}`,
    );
  return result.sort(
    (left, right) =>
      left.path.localeCompare(right.path, 'en') ||
      left.method.localeCompare(right.method, 'en'),
  );
}

describe('HTTP route and access contract', () => {
  let app: INestApplication | undefined;
  const previousSwagger = process.env.SWAGGER_ENABLED;

  beforeAll(async () => {
    if (!process.env.DATABASE_URL)
      throw new Error(
        'Route contract tests require the migrated application DATABASE_URL.',
      );
    process.env.SWAGGER_ENABLED = 'true';
    app = await NestFactory.create(AppModule, {
      logger: false,
      bodyParser: false,
    });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    if (previousSwagger === undefined) delete process.env.SWAGGER_ENABLED;
    else process.env.SWAGGER_ENABLED = previousSwagger;
  });

  it('preserves every registered HTTP method, path and effective access policy', () => {
    const inventory = registeredContracts(app!);
    expect(inventory.length).toBeGreaterThan(0);
    expect(inventory.some((route) => route.path === '/docs')).toBe(true);
    expect(inventory).toMatchSnapshot();
  });
});
