import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { BookingsService } from '../bookings/bookings.service';
import { AppConfig } from '../config';
import { MembershipsService } from '../memberships/memberships.service';
import { PlansService } from '../plans/plans.service';
import { JsonStore } from '../storage/json-store';
import { SettleKingWebhook } from './settleking.types';
import { verifyWebhook } from './webhook-signature';

/**
 * One SettleKing webhook delivery: verified against the raw bytes, deduplicated by webhook-id, then
 * offered to bookings (class payments, by checkout id), memberships (saved cards and membership
 * charges) and plans (payment agreements and their charges). Event types the studio does not use are acknowledged and ignored.
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly store: JsonStore,
    private readonly bookings: BookingsService,
    private readonly memberships: MembershipsService,
    private readonly plans: PlansService,
    private readonly config: AppConfig,
  ) {}

  /** Anything not signed by SettleKing is refused with 401. */
  async receive(rawBody: Buffer | undefined, headers: Record<string, string | string[] | undefined>) {
    const check = verifyWebhook(rawBody ?? '', headers, this.config.settleking.webhookSecret);
    if (!check.valid) {
      this.logger.warn(`Rejected webhook: ${check.reason}`);
      throw new UnauthorizedException('Invalid webhook signature');
    }
    if (this.store.hasWebhook(check.id)) return { outcome: 'duplicate' };

    const event = JSON.parse(rawBody!.toString('utf8')) as SettleKingWebhook;
    const data = event.data && typeof event.data === 'object' ? event.data : {};
    const appliedTo =
      (await this.bookings.handleWebhook({ ...event, data })) ??
      (await this.memberships.handleWebhook({ ...event, data })) ??
      (await this.plans.handleWebhook({ ...event, data }));
    await this.store.update((state) => {
      state.webhookIds.unshift(check.id);
    });
    const outcome = appliedTo ? 'applied' : 'ignored';
    this.logger.log(`Webhook ${event.type} ${outcome}${appliedTo ? ` for ${appliedTo}` : ''}`);
    return { outcome };
  }
}
