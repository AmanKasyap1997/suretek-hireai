import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
} from '@nestjs/common';
import { Response } from 'express';
import { jsonLog } from './logging';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    let status = 500;
    let payload: unknown = { message: 'Internal server error' };
    if (error instanceof HttpException) {
      status = error.getStatus();
      payload = error.getResponse();
    } else if ((error as { type?: string })?.type === 'entity.parse.failed') {
      status = 400;
      payload = { message: 'Invalid JSON body' };
    } else if ((error as { type?: string })?.type === 'entity.too.large') {
      status = 413;
      payload = { message: 'Request body is too large' };
    } else {
      const code = (error as { code?: string })?.code;
      if (code === '23505') {
        status = 409;
        payload = { message: 'A matching record already exists' };
      } else if (
        code === '23503' ||
        code === '23514' ||
        code === '22P02' ||
        code === '22007' ||
        code === '22008'
      ) {
        status = 400;
        payload = { message: 'Invalid record reference or value' };
      } else
        jsonLog('request_failed', {
          requestId: response.locals.requestId,
          level: 'error',
        });
    }
    response.status(status).json({
      statusCode: status,
      ...(typeof payload === 'string'
        ? { message: payload }
        : (payload as object)),
    });
  }
}
