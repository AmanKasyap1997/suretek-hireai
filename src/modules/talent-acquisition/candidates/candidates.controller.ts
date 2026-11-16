import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Roles } from '../../../shared/roles.decorator';
import { RECRUITMENT_ROLES } from '../../../shared/role-groups';
import { BodySchema, parse } from '../../../platform/http/validation';
import { candidateSchema, paginationSchema } from './candidates.schemas';
import { CandidatesService } from './candidates.service';

@ApiTags('Candidates')
@ApiBearerAuth()
@Roles(...RECRUITMENT_ROLES)
@Controller('candidates')
export class CandidatesController {
  constructor(private readonly hiring: CandidatesService) {}

  @Post()
  @BodySchema(candidateSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createCandidate(actor, parse(candidateSchema, body));
  }

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listCandidates(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getCandidate(actor, id);
  }
}
