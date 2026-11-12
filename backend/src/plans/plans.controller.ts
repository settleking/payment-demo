import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';

import { AdminGuard } from '../memberships/admin.guard';
import { CancelPlanDto } from './dto/cancel-plan.dto';
import { ChargePlanDto } from './dto/charge-plan.dto';
import { StartPlanDto } from './dto/start-plan.dto';
import { AppConfig } from '../config';
import { plansFor } from './plan.catalog';
import { PlansService } from './plans.service';

@Controller('plans')
export class PlansController {
  constructor(
    private readonly plans: PlansService,
    private readonly config: AppConfig,
  ) {}

  @Get()
  catalog() {
    return plansFor(this.config.planTestMinutes);
  }

  /** Proposes the plan's agreement; returns SettleKing's approval link or a widget client secret. */
  @Post()
  start(@Body() dto: StartPlanDto) {
    return this.plans.start(dto);
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.get(id);
  }

  /** Reads the agreement from SettleKing now (back from approval, widget success). */
  @Post(':id/sync')
  sync(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.sync(id);
  }

  /** The customer stops the plan; besides the link, they give the email they signed up with. */
  @Post(':id/cancel')
  cancel(@Param('id', new ParseUUIDPipe()) id: string, @Body() body: CancelPlanDto) {
    return this.plans.cancelByCustomer(id, body.email);
  }
}

/** The studio admin's plan API; every route needs X-Admin-Token. */
@Controller('admin/plans')
@UseGuards(AdminGuard)
export class AdminPlansController {
  constructor(private readonly plans: PlansService) {}

  @Get()
  list() {
    return this.plans.list();
  }

  @Post(':id/sync')
  sync(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.adminSync(id);
  }

  /** Pay as you dance: charge for one class attended. */
  @Post(':id/charges')
  charge(@Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ChargePlanDto) {
    return this.plans.charge(id, dto);
  }

  @Post(':id/cancel')
  cancel(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.plans.adminCancel(id);
  }
}
