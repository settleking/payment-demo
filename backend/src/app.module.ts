import { Controller, Get, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AdminBookingsController, BookingsController } from './bookings/bookings.controller';
import { BookingsService } from './bookings/bookings.service';
import { CLASSES } from './catalog/catalog.data';
import { AppConfig } from './config';
import { AdminGuard } from './memberships/admin.guard';
import { AdminMembersController, MembershipsController } from './memberships/memberships.controller';
import { MembershipsService } from './memberships/memberships.service';
import { plansFor } from './plans/plan.catalog';
import { AdminPlansController, PlansController } from './plans/plans.controller';
import { PlansService } from './plans/plans.service';
import { SettleKingClient } from './settleking/settleking.client';
import { WebhooksController } from './settleking/webhooks.controller';
import { WebhooksService } from './settleking/webhooks.service';
import { JsonStore } from './storage/json-store';
import { ThrottleMiddleware } from './throttle.middleware';

@Controller()
class CatalogController {
  constructor(private readonly config: AppConfig) {}

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Get('classes')
  classes() {
    return CLASSES;
  }

  /**
   * What the page needs to offer the embedded widget: the publishable key (public by design) and
   * where to load settleking.js from. Null when widgets are not configured; the page then offers
   * hosted checkout only. API and webhook secrets never leave the server.
   */
  @Get('config')
  settings() {
    const { publishableKey, payUrl } = this.config.settleking;
    return {
      studioName: this.config.studioName,
      widget: this.config.widgetsConfigured ? { publishableKey, payUrl } : null,
      membership: { amount: this.config.membershipAmount, currency: 'USD' },
      plans: plansFor(this.config.planTestMinutes),
      payUrl: this.config.settleking.payUrl,
      appUrl: this.config.settleking.appUrl,
    };
  }
}

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    CatalogController,
    BookingsController,
    AdminBookingsController,
    MembershipsController,
    AdminMembersController,
    PlansController,
    AdminPlansController,
    WebhooksController,
  ],
  providers: [
    AppConfig,
    JsonStore,
    SettleKingClient,
    BookingsService,
    MembershipsService,
    PlansService,
    WebhooksService,
    AdminGuard,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(ThrottleMiddleware).forRoutes('bookings', 'plans', 'memberships');
  }
}
