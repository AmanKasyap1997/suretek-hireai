import { LoggerService } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Request, Response, NextFunction } from 'express';

export function jsonLog(event: string, fields: Record<string, unknown> = {}) {
  process.stdout.write(
    JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n',
  );
}
/** Deliberately omit arbitrary framework/provider messages and exception objects. */
export class SafeJsonLogger implements LoggerService {
  log() {
    jsonLog('runtime', { level: 'info' });
  }
  error() {
    jsonLog('runtime', { level: 'error' });
  }
  warn() {
    jsonLog('runtime', { level: 'warn' });
  }
  debug() {
    /* Disabled: may contain application data. */
  }
  verbose() {
    /* Disabled. */
  }
  fatal() {
    jsonLog('runtime', { level: 'fatal' });
  }
}
export function requestLogging(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  // Generate locally: never trust a client-supplied request ID.
  const requestId = randomUUID();
  res.locals.requestId = requestId;
  res.setHeader('X-Request-ID', requestId);
  const start = performance.now();
  res.once('close', () =>
    jsonLog('http_request', {
      requestId,
      method: req.method,
      status: res.statusCode,
      durationMs: Math.round(performance.now() - start),
    }),
  );
  // No URL, route parameters, query, headers, body, IP or user identifiers.
  next();
}
