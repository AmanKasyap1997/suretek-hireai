import {
  Controller,
  Get,
  Post,
  Param,
  ParseUUIDPipe,
  UploadedFile,
  UseInterceptors,
  StreamableFile,
  BadRequestException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { Role } from '../../../shared/enums';
import { readConfig } from '../../../platform/config';
import { DocumentsService, ResumeUpload } from './documents.service';
@ApiTags('Candidate documents')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('candidates/:candidateId/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}
  @Post()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    }),
  )
  upload(
    @CurrentUser() actor: Actor,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @UploadedFile() file: ResumeUpload | undefined,
  ) {
    if (!file) throw new BadRequestException('A resume file is required');
    // Multer has a hard ceiling; the configured (usually smaller) limit is checked by the service.
    if (file.buffer.length > readConfig().RESUME_MAX_BYTES)
      throw new PayloadTooLargeException(
        'Resume exceeds configured size limit',
      );
    return this.documents.upload(actor, candidateId, file);
  }
  @Get()
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  list(
    @CurrentUser() actor: Actor,
    @Param('candidateId', ParseUUIDPipe) id: string,
  ) {
    return this.documents.list(actor, id);
  }
  @Get(':id/download')
  @Roles(...RECRUITMENT_ROLES, Role.HIRING_MANAGER)
  async download(
    @CurrentUser() actor: Actor,
    @Param('candidateId', ParseUUIDPipe) candidateId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const file = await this.documents.download(actor, candidateId, id);
    return new StreamableFile(file.bytes, {
      type: file.contentType,
      disposition: `attachment; filename="${file.filename}"`,
      length: file.bytes.length,
    });
  }
}
