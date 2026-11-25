import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser, Role } from '../../shared/actor';
import { Roles } from '../../shared/roles.decorator';
import { BodySchema, parse } from '../../platform/http/validation';
import {
  OrganizationAiService,
  aiCallingSchema,
  aiSettingsSchema,
} from './organization-ai';

@ApiTags('Integrations')
@ApiBearerAuth()
@Controller('organization/ai-settings')
@Roles(Role.HR_ADMIN)
export class AiSettingsController {
  constructor(private readonly ai: OrganizationAiService) {}

  @Get()
  @ApiOperation({
    summary:
      'Which AI provider screens resumes, the enabled providers to choose from, and any problem with the choice.',
  })
  get(@CurrentUser() actor: Actor) {
    return this.ai.settingsView(actor.tenantId);
  }

  @Put()
  @BodySchema(aiSettingsSchema)
  @ApiOperation({
    summary:
      'Choose the AI provider for resume screening (null for automatic) and whether another enabled provider may screen when it can’t be used.',
  })
  update(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.ai.updateSettings(actor, parse(aiSettingsSchema, body));
  }

  @Put('calling')
  @BodySchema(aiCallingSchema)
  @ApiOperation({
    summary:
      'Turn AI calling on or off. Calls aren’t placed yet; when on, recruiters prepare each job’s call questions.',
  })
  calling(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.ai.updateCalling(actor, parse(aiCallingSchema, body).enabled);
  }
}
