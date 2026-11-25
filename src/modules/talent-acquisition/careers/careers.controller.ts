import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  HttpCode,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { Public } from '../../../shared/roles.decorator';
import {
  BodySchema,
  parse,
  paginationSchema,
} from '../../../platform/http/validation';
import type { ResumeUpload } from '../documents';
import { CareersService } from './careers.service';
import {
  ApplicationFields,
  applicationFieldsSchema,
  intakeSchema,
  tenantSlugSchema,
} from './careers.schemas';

const invalid = (path: string, message: string) =>
  new BadRequestException({
    message: 'Validation failed',
    errors: [{ path, message }],
  });

/**
 * Two ways to apply: multipart/form-data with the form as JSON in an
 * `application` part and the file in a `resume` part (up to RESUME_MAX_BYTES),
 * or the original JSON body with a base64 resume (up to 512 KiB).
 */
export function readSubmission(
  req: Pick<Request, 'is'>,
  body: unknown,
  file: ResumeUpload | undefined,
): { fields: ApplicationFields; resume?: ResumeUpload } {
  if (req.is('multipart/form-data')) {
    const raw = (body as Record<string, unknown> | undefined)?.application;
    if (typeof raw !== 'string')
      throw invalid('application', 'Send the form fields as JSON');
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw invalid('application', 'Send the form fields as JSON');
    }
    const fields = parse(applicationFieldsSchema, json);
    return {
      fields,
      resume: file && { originalname: file.originalname, buffer: file.buffer },
    };
  }
  const { resume, ...fields } = parse(intakeSchema, body);
  return {
    fields,
    resume: {
      originalname: resume.filename,
      buffer: Buffer.from(resume.base64, 'base64'),
    },
  };
}

@ApiTags('Public careers')
@Public()
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('public/:tenantSlug/jobs')
export class CareersController {
  constructor(private readonly careers: CareersService) {}
  @Get()
  list(@Param('tenantSlug') slug: string, @Query() query: unknown) {
    return this.careers.list(
      parse(tenantSlugSchema, slug),
      parse(paginationSchema, query),
    );
  }
  @Get(':id')
  get(
    @Param('tenantSlug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.careers.get(parse(tenantSlugSchema, slug), id);
  }
  @Post(':id/applications')
  @HttpCode(202)
  @ApiConsumes('multipart/form-data', 'application/json')
  @BodySchema(intakeSchema)
  @UseInterceptors(
    FileInterceptor('resume', {
      // Hard ceiling; the service checks the configured RESUME_MAX_BYTES.
      limits: {
        fileSize: 10 * 1024 * 1024,
        files: 1,
        fields: 1,
        parts: 2,
        fieldSize: 64 * 1024,
      },
    }),
  )
  apply(
    @Param('tenantSlug') slug: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @UploadedFile() file: ResumeUpload | undefined,
    @Req() req: Request,
  ) {
    const tenant = parse(tenantSlugSchema, slug);
    const { fields, resume } = readSubmission(req, body, file);
    return this.careers.apply(
      tenant,
      id,
      fields,
      resume,
      req.ip ?? req.socket.remoteAddress ?? '0.0.0.0',
      req.headers['user-agent'] ?? '',
    );
  }
}
