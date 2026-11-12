import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { findClass } from '../catalog/catalog.data';
import { AppConfig } from '../config';
import { toCents, toMoney } from '../settleking/money';
import { SettleKingClient, SettleKingError } from '../settleking/settleking.client';
import {
  Agreement,
  AGREEMENT_UPDATED,
  AgreementCharge,
  AgreementUpdated,
  PAYMENT_FAILED,
  PAYMENT_RECEIVED,
  PaymentFailed,
  PaymentReceived,
  SettleKingWebhook,
} from '../settleking/settleking.types';
import { JsonStore } from '../storage/json-store';
import { ChargePlanDto } from './dto/charge-plan.dto';
import { StartPlanDto } from './dto/start-plan.dto';
import { findPlan, Plan } from './plan.catalog';
import { adminPlanView, customerView, PlanCharge, Subscription } from './plan.model';

/** SettleKing answers that mean "refused, nothing happened". */
const DEFINITE_REFUSALS = new Set([400, 401, 403, 404, 409, 422]);

/** What the customer's page needs to continue: SettleKing's approval page, or the widget. */
export interface StartedPlan {
  planId: string;
  approvalUrl?: string;
  clientSecret?: string;
}

/**
 * Plans: subscriptions and pay-as-you-dance, each one SettleKing payment agreement.
 *
 * The studio proposes the terms (POST /agreements) and the customer approves them once on
 * SettleKing, on its approval page or from the studio's page through the agreement widget. From then
 * on SettleKing charges subscriptions on schedule by itself; pay-as-you-dance is charged by the
 * studio admin (POST /agreements/{id}/charges) after each class, within the approved limits. The
 * studio learns what happened from MERCHANT_AGREEMENT_UPDATED and payment webhooks, a lookup when
 * the customer comes back, and a one-minute sweep.
 */
@Injectable()
export class PlansService {
  private readonly logger = new Logger(PlansService.name);

  constructor(
    private readonly store: JsonStore,
    private readonly settleking: SettleKingClient,
    private readonly config: AppConfig,
  ) {}

  /**
   * Records the plan, proposes the agreement to SettleKing (Idempotency-Key = plan id, so a retry
   * never proposes twice) and returns where the customer approves it.
   */
  async start(dto: StartPlanDto): Promise<StartedPlan> {
    const plan = findPlan(dto.planId);
    if (!plan) throw new BadRequestException('Choose a plan');
    if (dto.approveVia === 'widget' && !this.config.widgetsConfigured) {
      throw new BadRequestException('Approving on this page is not available; continue to SettleKing.');
    }
    if (!this.config.paymentsConfigured) throw new ServiceUnavailableException('Online payments are not set up yet.');
    const email = dto.email.toLowerCase();
    const now = new Date().toISOString();
    const subscription = await this.store.update((data) => {
      const created: Subscription = {
        id: randomUUID(),
        reference: `TDS-P${data.nextReference++}`,
        planId: plan.id,
        type: plan.type,
        name: dto.name,
        email,
        approvedVia: dto.approveVia,
        status: 'proposing',
        charges: [],
        chargeRequests: 0,
        createdAt: now,
        updatedAt: now,
      };
      data.plans.unshift(created);
      return { ...created };
    });

    let agreement: Agreement;
    try {
      agreement = await this.settleking.createAgreement(this.terms(plan, subscription), `${subscription.id}-agreement`);
    } catch (error) {
      this.logger.warn(`Proposing ${subscription.reference} failed: ${(error as Error).message}`);
      throw this.toHttp(error, 'We could not set up the plan. Please try again.');
    }
    await this.applyAgreement(subscription.id, agreement);

    if (dto.approveVia === 'hosted') {
      if (!agreement.approvalUrl) throw new BadGatewayException('SettleKing returned no approval link.');
      return { planId: subscription.id, approvalUrl: agreement.approvalUrl };
    }
    try {
      const session = await this.settleking.createWidgetSession(
        { widgetId: this.config.settleking.widgetId, mode: 'agreement', agreementId: agreement.id },
        `${subscription.id}-widget`,
      );
      await this.change(subscription.id, (current) => {
        current.widgetSessionId = session.id;
      });
      if (!session.clientSecret) throw new BadGatewayException('SettleKing returned no widget session.');
      return { planId: subscription.id, clientSecret: session.clientSecret };
    } catch (error) {
      this.logger.warn(`Agreement widget for ${subscription.reference} failed: ${(error as Error).message}`);
      // The agreement still stands: the customer can approve it on SettleKing's page instead.
      if (agreement.approvalUrl) return { planId: subscription.id, approvalUrl: agreement.approvalUrl };
      throw this.toHttp(error, 'We could not open the approval form. Please try again.');
    }
  }

  get(id: string) {
    return customerView(this.require(id));
  }

  /** Reads the agreement and its charges from SettleKing now (return page, widget success). */
  async sync(id: string) {
    await this.refresh(id);
    return customerView(this.require(id));
  }

  /**
   * The customer stops the plan from the studio's page (they can also cancel it in SettleKing).
   * The plan id in the link is the only key; a real studio would ask the customer to sign in.
   */
  async cancelByCustomer(id: string, email: string) {
    // The link alone (it travels in URLs and history) is not enough to stop someone's plan.
    if (this.require(id).email !== email.trim().toLowerCase()) {
      throw new ForbiddenException('That is not the email this plan was set up with.');
    }
    await this.cancel(id, 'customer_cancelled_at_studio');
    return customerView(this.require(id));
  }

  list() {
    return this.store.plans().map(adminPlanView);
  }

  async adminSync(id: string) {
    await this.refresh(id);
    return adminPlanView(this.require(id));
  }

  async adminCancel(id: string) {
    await this.cancel(id, 'studio_cancelled');
    return adminPlanView(this.require(id));
  }

  /**
   * Admin: charges a pay-as-you-dance plan for one class. The request is recorded before SettleKing
   * is called, with Idempotency-Key = plan id + request number: if the answer is lost, charging
   * again resends the same key and SettleKing returns the same charge instead of charging twice.
   */
  async charge(id: string, dto: ChargePlanDto) {
    const item = findClass(dto.classId);
    if (!item) throw new BadRequestException('Choose a class');
    const pending = await this.store.update((data) => {
      const plan = data.plans.find((candidate) => candidate.id === id);
      if (!plan) throw new NotFoundException('Plan not found');
      if (plan.type !== 'on_demand') throw new ConflictException('Only pay-as-you-dance plans are charged by the studio.');
      if (!plan.agreementId || plan.status !== 'active') {
        throw new ConflictException('This plan is not active, so it cannot be charged.');
      }
      const unanswered = plan.charges.find((charge) => charge.status === 'requesting');
      if (unanswered) return { ...unanswered };
      plan.chargeRequests += 1;
      const now = new Date().toISOString();
      const created: PlanCharge = {
        status: 'requesting',
        amount: item.amount,
        reference: `${plan.reference}-C${plan.chargeRequests}`,
        description: `${item.title}, ${item.schedule}`,
        idempotencyKey: `${plan.id}-charge-${plan.chargeRequests}`,
        initiatedBy: 'merchant_api',
        createdAt: now,
      };
      plan.charges.unshift(created);
      plan.updatedAt = now;
      return { ...created };
    });

    const plan = this.require(id);
    try {
      const charge = await this.settleking.chargeAgreement(
        plan.agreementId!,
        { amount: toMoney(pending.amount, 'USD'), reference: pending.reference ?? undefined, description: pending.description ?? undefined },
        pending.idempotencyKey!,
      );
      await this.change(id, (current) => {
        const index = current.charges.findIndex((candidate) => candidate.idempotencyKey === pending.idempotencyKey);
        const merged = { ...fromCharge(charge), idempotencyKey: pending.idempotencyKey };
        if (index >= 0) current.charges[index] = merged;
        else current.charges.unshift(merged);
      });
      this.logger.log(`${pending.reference}: ${charge.status}${charge.failureCode ? ` (${charge.failureCode})` : ''}`);
    } catch (error) {
      if (error instanceof SettleKingError && DEFINITE_REFUSALS.has(error.status)) {
        await this.change(id, (current) => {
          const charge = current.charges.find((candidate) => candidate.idempotencyKey === pending.idempotencyKey);
          if (charge) {
            charge.status = 'rejected';
            charge.failureCode = error.code ?? `HTTP_${error.status}`;
            charge.failureMessage = error.message;
          }
        });
        await this.refresh(id);
        throw new BadRequestException(`SettleKing refused the charge: ${error.message}`);
      }
      this.logger.warn(`Charge ${pending.reference}: no answer from SettleKing: ${(error as Error).message}`);
      throw new BadGatewayException('SettleKing did not answer. Charge again: the retry cannot charge twice.');
    }
    return adminPlanView(this.require(id));
  }

  /**
   * Applies a verified, first-seen webhook about a plan: an agreement status change, or the outcome
   * of one of its charges (payment events name the charge's checkout, not the agreement). Returns
   * what it applied to, or undefined when it is not about a plan.
   */
  async handleWebhook(event: SettleKingWebhook): Promise<string | undefined> {
    if (event.type === AGREEMENT_UPDATED) {
      const update = event.data as unknown as AgreementUpdated;
      const plan = this.store.plans().find((candidate) => candidate.agreementId === update.agreementId);
      if (!plan) return undefined;
      // The webhook says something changed; the agreement itself is the truth, so read it.
      await this.refresh(plan.id);
      return plan.reference;
    }
    if (event.type !== PAYMENT_RECEIVED && event.type !== PAYMENT_FAILED) return undefined;
    const data = event.data as unknown as PaymentReceived | PaymentFailed;
    if (data.origin !== 'agreement') return undefined;
    const known = this.store
      .plans()
      .find((plan) => plan.charges.some((charge) => charge.checkoutSessionId === data.checkoutSessionId));
    if (known) {
      await this.refresh(known.id);
      return known.reference;
    }
    // A charge the studio has not seen yet (a scheduled one): read the plans it can belong to.
    for (const plan of this.store.plans().filter((candidate) => candidate.status === 'active' || candidate.status === 'suspended')) {
      await this.refresh(plan.id);
      if (this.require(plan.id).charges.some((charge) => charge.checkoutSessionId === data.checkoutSessionId)) {
        return plan.reference;
      }
    }
    return undefined;
  }

  /** Every minute: pick up approvals, scheduled charges and outcomes whose webhook has not arrived. */
  @Interval(60_000)
  async reconcile(): Promise<void> {
    if (!this.config.paymentsConfigured) return;
    for (const plan of this.store.plans()) {
      if (plan.status === 'cancelled' || plan.status === 'expired') continue;
      if (plan.status === 'proposing' && !plan.agreementId) continue;
      await this.refresh(plan.id);
    }
  }

  /** The agreement's terms, built only from the studio's own catalog. */
  private terms(plan: Plan, subscription: Subscription) {
    const base = {
      type: plan.type,
      reference: subscription.reference,
      description: `${this.config.studioName}: ${plan.title}`,
      merchantName: this.config.settleking.merchantName,
      paymentMethods: ['wallet', 'card'] as ('wallet' | 'card')[],
      returnUrl: `${this.config.publicUrl}/?plan=${encodeURIComponent(subscription.id)}`,
      // Only the customer who signed up here can approve: a forwarded link is useless to others.
      payerEmail: subscription.email,
      expiresInSeconds: 24 * 60 * 60,
    };
    if (plan.type === 'on_demand') {
      return {
        ...base,
        maxAmountPerCharge: toMoney(plan.maxPerCharge!, 'USD'),
        maxAmountPerMonth: toMoney(plan.maxPerMonth!, 'USD'),
      };
    }
    return {
      ...base,
      amount: toMoney(plan.amount!, 'USD'),
      interval: plan.interval,
      intervalCount: 1,
      firstChargeAt: plan.trialDays
        ? new Date(Date.now() + plan.trialDays * 24 * 60 * 60_000).toISOString()
        : undefined,
    };
  }

  private async cancel(id: string, reason: string): Promise<void> {
    const plan = this.require(id);
    if (!plan.agreementId) throw new ConflictException('This plan was never set up.');
    if (plan.status === 'cancelled' || plan.status === 'expired') return;
    try {
      const agreement = await this.settleking.cancelAgreement(plan.agreementId, reason, `${plan.id}-cancel`);
      await this.applyAgreement(id, agreement);
      this.logger.log(`${plan.reference} cancelled (${reason})`);
    } catch (error) {
      this.logger.warn(`Cancelling ${plan.reference} failed: ${(error as Error).message}`);
      throw this.toHttp(error, 'SettleKing could not cancel the plan. Please try again.');
    }
  }

  /** Reads the agreement and its charges from SettleKing and stores them; never throws. */
  private async refresh(id: string): Promise<void> {
    const plan = this.require(id);
    if (!plan.agreementId) return;
    try {
      const [agreement, charges] = await Promise.all([
        this.settleking.getAgreement(plan.agreementId),
        this.settleking.agreementCharges(plan.agreementId),
      ]);
      await this.applyAgreement(id, agreement, charges);
    } catch (error) {
      this.logger.warn(`Reading ${plan.reference} from SettleKing failed: ${(error as Error).message}`);
    }
  }

  private applyAgreement(id: string, agreement: Agreement, charges?: AgreementCharge[]): Promise<Subscription> {
    return this.change(id, (plan) => {
      if (plan.agreementId && plan.agreementId !== agreement.id) {
        this.logger.warn(`${plan.reference}: agreement ${agreement.id} is not this plan's; ignored`);
        return;
      }
      if (agreement.reference !== plan.reference) {
        this.logger.warn(`${plan.reference}: agreement reference ${agreement.reference} does not match; ignored`);
        return;
      }
      const before = plan.status;
      plan.agreementId = agreement.id;
      plan.status = agreement.status;
      plan.approvalUrl = agreement.approvalUrl ?? plan.approvalUrl;
      plan.requestExpiresAt = agreement.requestExpiresAt;
      plan.funding = agreement.funding ?? null;
      plan.nextChargeAt = agreement.nextChargeAt;
      plan.cycle = agreement.cycle;
      plan.chargedThisMonth = toCents(agreement.chargedThisMonth) ?? undefined;
      plan.endedBy = agreement.endedBy;
      plan.endReason = agreement.endReason;
      if (charges) {
        // SettleKing's list is the truth; keep only the studio's own unanswered request on top.
        const unanswered = plan.charges.filter(
          (charge) => charge.status === 'requesting' && !charges.some((known) => known.reference === charge.reference),
        );
        const keys = new Map(plan.charges.filter((charge) => charge.id).map((charge) => [charge.id, charge.idempotencyKey]));
        plan.charges = [
          ...unanswered,
          ...charges.map((charge) => ({ ...fromCharge(charge), idempotencyKey: keys.get(charge.id) })),
        ];
        plan.syncedAt = new Date().toISOString();
      }
      if (before !== plan.status) this.logger.log(`${plan.reference}: ${before} -> ${plan.status}`);
    });
  }

  private toHttp(error: unknown, fallback: string): Error {
    if (error instanceof SettleKingError) {
      if (error.code === 'NOT_CONFIGURED') return new ServiceUnavailableException('Online payments are not set up yet.');
      if (DEFINITE_REFUSALS.has(error.status)) return new BadRequestException(`SettleKing refused: ${error.message}`);
    }
    return new BadGatewayException(fallback);
  }

  private change(id: string, mutate: (plan: Subscription) => void): Promise<Subscription> {
    return this.store.update((data) => {
      const plan = data.plans.find((candidate) => candidate.id === id);
      if (!plan) throw new NotFoundException('Plan not found');
      mutate(plan);
      plan.updatedAt = new Date().toISOString();
      return plan;
    });
  }

  private require(id: string): Subscription {
    const plan = this.store.plan(id);
    if (!plan) throw new NotFoundException('Plan not found');
    return plan;
  }
}

function fromCharge(charge: AgreementCharge): PlanCharge {
  return {
    id: charge.id,
    status: charge.status,
    amount: toCents(charge.amount) ?? 0,
    cycle: charge.cycle,
    attempt: charge.attempt,
    reference: charge.reference,
    description: charge.description,
    fundingMethod: charge.fundingMethod,
    viaDeposit: charge.viaDeposit,
    failureCode: charge.failureCode,
    failureMessage: charge.failureMessage,
    initiatedBy: charge.initiatedBy,
    checkoutSessionId: charge.checkoutSessionId,
    createdAt: charge.createdAt ?? new Date().toISOString(),
    completedAt: charge.completedAt,
  };
}
