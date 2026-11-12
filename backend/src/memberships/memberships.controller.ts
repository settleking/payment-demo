import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { AdminGuard } from './admin.guard';
import { JoinMembershipDto } from './dto/join-membership.dto';
import { MembershipsService } from './memberships.service';

@Controller('memberships')
export class MembershipsController {
  constructor(private readonly memberships: MembershipsService) {}

  /** Opens a setup widget session for the member's card; returns its client secret for the page. */
  @Post()
  join(@Body() dto: JoinMembershipDto) {
    return this.memberships.join(dto);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.memberships.get(id);
  }

  /** Called when the widget reports success: confirms the saved card with SettleKing. */
  @Post(':id/sync')
  sync(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.memberships.sync(id);
  }
}

/** The studio admin panel's API; every route needs the X-Admin-Token header (ADMIN_TOKEN). */
@Controller('admin/members')
@UseGuards(AdminGuard)
export class AdminMembersController {
  constructor(private readonly memberships: MembershipsService) {}

  @Get()
  list() {
    return this.memberships.list();
  }

  /** Charges this month's membership to the member's saved card. */
  @Post(':id/charges')
  charge(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.memberships.charge(id);
  }

  /** The charge's current state, read from SettleKing (GET /payments/{id}). */
  @Get(':id/charges/:chargeId')
  refreshCharge(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('chargeId', new ParseUUIDPipe()) chargeId: string,
  ) {
    return this.memberships.refreshCharge(id, chargeId);
  }

  @Delete(':id/card')
  removeCard(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.memberships.removeCard(id);
  }
}
