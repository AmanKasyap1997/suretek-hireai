import {
  Controller,
  Param,
  ParseUUIDPipe,
  Post,
  HttpCode,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../../shared/roles.decorator';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { Actor, CurrentUser } from '../../../shared/actor';
import { PrivacyService } from './privacy.service';
@ApiTags('Candidate privacy')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('candidates')
export class PrivacyController {
  constructor(private readonly privacy: PrivacyService) {}
  @Post(':id/erase')
  @HttpCode(200)
  erase(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.privacy.erase(actor, id);
  }
}
