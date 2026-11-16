import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BodySchema, parse } from '../../../platform/http/validation';
import { Actor, CurrentUser } from '../../../shared/actor';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { Roles } from '../../../shared/roles.decorator';
import { completionSchema } from './onboarding.schemas';
import { OnboardingService } from './onboarding.service';

@ApiTags('Core HR')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get('employees/:id/onboarding-tasks')
  @ApiOperation({ operationId: 'HrController_tasks', summary: undefined })
  tasks(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.onboarding.tasks(actor, id);
  }

  @Patch('onboarding-tasks/:id')
  @BodySchema(completionSchema)
  @ApiOperation({ operationId: 'HrController_complete', summary: undefined })
  complete(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    return this.onboarding.complete(actor, id, parse(completionSchema, body));
  }
}
