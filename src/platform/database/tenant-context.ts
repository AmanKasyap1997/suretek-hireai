import { AsyncLocalStorage } from 'node:async_hooks';
import { NextFunction, Request, Response } from 'express';
import { z } from 'zod';

export interface TenantContext {
  tenantId?: string;
  ip?: string;
  userAgent?: string;
}

/** A fresh store per HTTP request prevents tenant state crossing requests. */
export const tenantContext = new AsyncLocalStorage<TenantContext>();
const tenantIdSchema = z.string().uuid();

function validateTenantId(tenantId: string): void {
  if (!tenantIdSchema.safeParse(tenantId).success) {
    throw new Error('Tenant ID must be a valid UUID');
  }
}

export function tenantContextMiddleware(
  _request: Request,
  _response: Response,
  next: NextFunction,
): void {
  tenantContext.run(
    {
      ip: _request.ip?.slice(0, 100),
      userAgent: _request.get('user-agent')?.slice(0, 500),
    },
    next,
  );
}

/** Assign only within an existing request; never create ambient global state. */
export function setTenantId(tenantId: string): void {
  validateTenantId(tenantId);
  const context = tenantContext.getStore();
  if (!context) throw new Error('Tenant context has not been initialized');
  context.tenantId = tenantId;
}

/** Scope scripts and tests explicitly without changing their parent context. */
export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  validateTenantId(tenantId);
  return tenantContext.run({ tenantId }, fn);
}
