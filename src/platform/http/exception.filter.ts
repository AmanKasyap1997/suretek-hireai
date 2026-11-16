import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('API');
  catch(error: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();
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
        this.logger.error(
          `Request failed: ${request.method} ${request.route?.path ?? 'unknown'} (${error instanceof Error ? error.name : 'unknown'})`,
        );
    }
    response.status(status).json({
      statusCode: status,
      ...(typeof payload === 'string'
        ? { message: payload }
        : (payload as object)),
    });
  }
}
