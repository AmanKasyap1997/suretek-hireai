import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Actor, CurrentUser } from '../../../shared/actor';
import { Roles } from '../../../shared/roles.decorator';
import { ADMIN_ROLES } from '../../../shared/role-groups';
import { BodySchema, parse } from '../../../platform/http/validation';
import {
  offerSchema,
  acceptOfferSchema,
  paginationSchema,
} from './offers.schemas';
import { OffersService } from './offers.service';

@ApiTags('Offers')
@ApiBearerAuth()
@Roles(...ADMIN_ROLES)
@Controller('offers')
export class OffersController {
  constructor(private readonly hiring: OffersService) {}

  @Post()
  @BodySchema(offerSchema)
  create(@CurrentUser() actor: Actor, @Body() body: unknown) {
    return this.hiring.createOffer(actor, parse(offerSchema, body));
  }

  @Get()
  list(@CurrentUser() actor: Actor, @Query() query: unknown) {
    return this.hiring.listOffers(actor, parse(paginationSchema, query));
  }

  @Get(':id')
  get(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.getOffer(actor, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.approveOffer(actor, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  @BodySchema(acceptOfferSchema)
  @ApiOperation({
    summary:
      'HR records verified candidate acceptance with an evidence reference; this is not an e-signature.',
  })
  accept(
    @CurrentUser() actor: Actor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ) {
    const input = parse(acceptOfferSchema, body);
    return this.hiring.acceptOffer(actor, id, input.acceptanceReference);
  }

  @Post(':id/hire')
  @ApiOperation({
    summary:
      'Create one employee and onboarding checklist from an accepted offer; safe to retry.',
  })
  hire(@CurrentUser() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.hiring.hire(actor, id);
  }
}
