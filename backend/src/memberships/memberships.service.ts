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

import { AppConfig } from '../config';
import { isAmount, toMoney } from '../settleking/money';
import { isCapabilityMissing, SettleKingClient, SettleKingError } from '../settleking/settleking.client';
import {
  CheckoutStatus,
  Money,
  PAYMENT_FAILED,
  PAYMENT_METHOD_SAVED,
  PAYMENT_RECEIVED,
  PAYMENT_REVERSED,
  PaymentFailed,
  PaymentMethodSaved,
  PaymentReceived,
  SettleKingWebhook,
  WidgetSession,
} from '../settleking/settleking.types';
import { JsonStore } from '../storage/json-store';
import { JoinMembershipDto } from './dto/join-membership.dto';
import { adminView, Member, MemberCharge, memberView, SavedCard } from './member.model';

export const CAPABILITY_MESSAGE =
  'Saving customers’ cards and charging them later is not enabled for this studio. Contact SettleKing support.';

/** A saved card as SettleKing reported it (setup session lookup or webhook). */
interface SavedCardFacts {
  customerId: string;
  paymentMethodId: string;
  widgetSessionId?: string | null;
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  savedAt?: string | null;
}

/** A payment's state as SettleKing reported it (payment lookup or webhook). */
interface PaymentState {
  id: string;
  status: CheckoutStatus;
  reference: string;
  amount: Money;
  failureCode?: string | null;
  paidAt?: string | null;
}

/** SettleKing answers that mean "refused, nothing happened": a new attempt may use a new key. */
const DEFINITE_REFUSALS = new Set([400, 401, 403, 404, 422]);

/** How long after opening a card form the sweep keeps asking whether a card was saved. */
const SETUP_WATCH_MS = 2 * 60 * 60_000;

/**
 * Monthly memberships: a member saves a card once in a SettleKing setup widget, and the studio
 * charges the membership to it later, without the member present (a merchant-initiated payment).
 * Saving and charging need SettleKing's merchant-initiated payments capability, which SettleKing
 * operations grant; without it SettleKing answers 403 CAPABILITY_NOT_ENABLED.
 */
@Injectable()
export class MembershipsService {
  private readonly logger = new Logger(MembershipsService.name);

  constructor(
    private readonly store: JsonStore,
    private readonly settleking: SettleKingClient,
    private readonly config: AppConfig,
  ) {}

  /**
   * Starts (or restarts) a membership: opens a setup widget session for the member's SettleKing
   * customer (the studio's reference for it is the lowercased email) and returns its client secret.
   */
  async join(dto: JoinMembershipDto): Promise<{ memberId: string; clientSecret: string }> {
    if (!this.config.widgetsConfigured) throw new BadRequestException('Memberships are not available yet.');
    const email = dto.email.toLowerCase();
    const existing = this.store.memberByEmail(email);
    if (existing?.cardStatus === 'active') {
      throw new ConflictException('You’re already a member with a saved card. Ask the studio to change it.');
    }
    const memberId = existing?.id ?? randomUUID();
    const attempt = (existing?.setupAttempts ?? 0) + 1;

    let session: WidgetSession;
    try {
      session = await this.settleking.createWidgetSession(
        {
          widgetId: this.config.settleking.widgetId,
          mode: 'setup',
          description: `${this.config.studioName} monthly membership: ${dollars(this.config.membershipAmount)} a month`,
          customer: { reference: email, email, name: dto.name },
          // Merchant-initiated charges are card payments.
          paymentMethods: ['card'],
        },
        `${memberId}-setup-${attempt}`,
      );
    } catch (error) {
      this.logger.warn(`Setup session for ${email} failed: ${(error as Error).message}`);
      if (isCapabilityMissing(error)) throw new ForbiddenException(CAPABILITY_MESSAGE);
      if (error instanceof SettleKingError && error.code === 'NOT_CONFIGURED') {
        throw new ServiceUnavailableException('Online payments are not set up yet.');
      }
      throw new BadGatewayException('We could not open the card form. Please try again.');
    }
    if (!session.clientSecret) throw new BadGatewayException('We could not open the card form. Please try again.');

    const now = new Date().toISOString();
    await this.store.update((data) => {
      let member = data.members.find((candidate) => candidate.id === memberId);
      if (!member) {
        member = {
          id: memberId,
          reference: `TDS-M${data.nextReference++}`,
          // Kept from the first sign-up: an unauthenticated form must not rename an existing member.
          name: dto.name,
          email,
          setupAttempts: 0,
          cardStatus: 'none',
          charges: [],
          createdAt: now,
          updatedAt: now,
        };
        data.members.unshift(member);
      }
      member.setupAttempts = attempt;
      member.setupSessionId = session.id;
      member.setupStartedAt = now;
      member.customerId = session.customerId ?? member.customerId;
      if (member.cardStatus !== 'active') member.cardStatus = 'pending';
      member.updatedAt = now;
    });
    return { memberId, clientSecret: session.clientSecret };
  }

  get(id: string) {
    return memberView(this.require(id));
  }

  /**
   * Called when the widget reports success: asks SettleKing, server to server, whether the setup
   * session saved a card and which one. The browser's event is never trusted.
   */
  async sync(id: string) {
    const member = this.require(id);
    if (member.cardStatus !== 'pending' || !member.setupSessionId) return memberView(member);
    try {
      const session = await this.settleking.getWidgetSession(member.setupSessionId);
      if (session.mode === 'setup' && session.status === 'succeeded' && session.paymentMethodId && session.customerId) {
        const cards = await this.settleking.customerPaymentMethods(session.customerId);
        const card = cards.find((candidate) => candidate.id === session.paymentMethodId && candidate.status === 'active');
        if (card) {
          await this.applySavedCard(
            id,
            { ...card, paymentMethodId: card.id, widgetSessionId: session.id, savedAt: session.completedAt },
            'lookup',
          );
        } else {
          this.logger.warn(`${member.reference}: the saved card is no longer active at SettleKing`);
        }
      } else if (session.status === 'expired') {
        await this.change(id, (current) => {
          if (current.cardStatus === 'pending' && current.setupSessionId === session.id) current.cardStatus = 'none';
        });
      }
    } catch (error) {
      this.logger.warn(`Setup lookup for ${member.reference} failed: ${(error as Error).message}`);
    }
    return memberView(this.require(id));
  }

  /** Admin: every member, newest first. */
  list() {
    return this.store.members().map(adminView);
  }

  /**
   * Admin: charges this month's membership to the member's saved card now. Each attempt is recorded
   * before SettleKing is called, with Idempotency-Key = member id + month + attempt: if the answer
   * is lost, "Charge now" resends the same key, and SettleKing returns the same payment rather than
   * charging again. After a decline the next attempt gets a new key.
   */
  async charge(id: string) {
    const period = new Date().toISOString().slice(0, 7);
    const charge = await this.store.update((data) => {
      const member = data.members.find((candidate) => candidate.id === id);
      if (!member) throw new NotFoundException('Member not found');
      if (member.cardStatus !== 'active' || !member.card || !member.customerId) {
        throw new ConflictException('This member has no saved card.');
      }
      const thisMonth = member.charges.filter((candidate) => candidate.period === period);
      const unanswered = thisMonth.find((candidate) => candidate.status === 'requesting');
      if (unanswered) return { ...unanswered };
      if (thisMonth.some((candidate) => candidate.status === 'processing' || candidate.status === 'paid')) {
        throw new ConflictException(`${member.name} is already charged for ${period}.`);
      }
      const attempt = thisMonth.length + 1;
      const now = new Date().toISOString();
      const created: MemberCharge = {
        id: randomUUID(),
        period,
        attempt,
        idempotencyKey: `${member.id}-${period}-${attempt}`,
        reference: `${member.reference}-${period}-${attempt}`,
        amount: this.config.membershipAmount,
        currency: 'USD',
        status: 'requesting',
        createdAt: now,
        updatedAt: now,
      };
      member.charges.unshift(created);
      member.updatedAt = now;
      return { ...created };
    });

    const member = this.require(id);
    try {
      const payment = await this.settleking.createPayment(
        {
          customerId: member.customerId!,
          paymentMethodId: member.card!.paymentMethodId,
          amount: toMoney(charge.amount, charge.currency),
          reference: charge.reference,
          description: `Monthly membership ${period} for ${member.name}`,
          merchantName: this.config.settleking.merchantName,
        },
        charge.idempotencyKey,
      );
      await this.applyPaymentState(id, charge.id, payment, 'lookup');
    } catch (error) {
      if (error instanceof SettleKingError && DEFINITE_REFUSALS.has(error.status)) {
        await this.changeCharge(id, charge.id, (current) => {
          current.status = 'failed';
          current.failureCode = error.code ?? `HTTP_${error.status}`;
        });
        if (isCapabilityMissing(error)) throw new ForbiddenException(CAPABILITY_MESSAGE);
        throw new BadRequestException(`SettleKing refused the charge: ${error.message}`);
      }
      this.logger.warn(`Charge ${charge.reference}: no answer from SettleKing: ${(error as Error).message}`);
      if (error instanceof SettleKingError && error.code === 'NOT_CONFIGURED') {
        throw new ServiceUnavailableException('Online payments are not set up yet.');
      }
      throw new BadGatewayException('SettleKing did not answer. Charge again: the retry cannot charge twice.');
    }
    return adminView(this.require(id));
  }

  /** Admin: reads the charge's payment from SettleKing (GET /payments/{id}) and records its state. */
  async refreshCharge(id: string, chargeId: string) {
    const charge = this.requireCharge(id, chargeId);
    if (charge.paymentId && (charge.status === 'processing' || charge.status === 'requesting')) {
      try {
        await this.applyPaymentState(id, chargeId, await this.settleking.getPayment(charge.paymentId), 'lookup');
      } catch (error) {
        this.logger.warn(`Payment lookup for ${charge.reference} failed: ${(error as Error).message}`);
      }
    }
    return adminView(this.require(id));
  }

  /** Admin: removes the member's saved card at SettleKing; it can never be charged again. */
  async removeCard(id: string) {
    const member = this.require(id);
    if (member.cardStatus !== 'active' || !member.card || !member.customerId) {
      throw new ConflictException('This member has no saved card.');
    }
    try {
      await this.settleking.detachPaymentMethod(member.customerId, member.card.paymentMethodId);
    } catch (error) {
      this.logger.warn(`Removing ${member.reference}'s card failed: ${(error as Error).message}`);
      throw new BadGatewayException('SettleKing could not remove the card. Please try again.');
    }
    await this.change(id, (current) => {
      current.cardStatus = 'removed';
      if (current.card) current.card.removedAt = new Date().toISOString();
    });
    this.logger.log(`${member.reference}: card removed`);
    return adminView(this.require(id));
  }

  /**
   * Applies a verified, first-seen webhook about a member: a saved card, or the outcome of a
   * membership charge. Returns what it applied to, or undefined when it is not about a member.
   */
  async handleWebhook(event: SettleKingWebhook): Promise<string | undefined> {
    if (event.type === PAYMENT_METHOD_SAVED) {
      const saved = event.data as unknown as PaymentMethodSaved;
      const members = this.store.members();
      const member =
        (saved.widgetSessionId ? members.find((candidate) => candidate.setupSessionId === saved.widgetSessionId) : undefined) ??
        members.find((candidate) => candidate.customerId === saved.customerId);
      if (!member) return undefined;
      await this.applySavedCard(member.id, saved, 'webhook');
      return member.reference;
    }
    if (event.type !== PAYMENT_RECEIVED && event.type !== PAYMENT_FAILED && event.type !== PAYMENT_REVERSED) {
      return undefined;
    }
    const data = event.data as unknown as PaymentReceived | PaymentFailed;
    const found = this.findCharge(data.checkoutSessionId, data.reference);
    if (!found) return undefined;
    const state: PaymentState = {
      id: data.checkoutSessionId,
      reference: data.reference,
      amount: data.amount,
      status: event.type === PAYMENT_RECEIVED ? 'paid' : event.type === PAYMENT_FAILED ? 'failed' : 'reversed',
      failureCode: 'failureCode' in data ? data.failureCode : undefined,
      paidAt: 'paidAt' in data ? data.paidAt : undefined,
    };
    await this.applyPaymentState(found.member.id, found.charge.id, state, 'webhook');
    return found.charge.reference;
  }

  /** Every minute: pick up saved cards and charge outcomes whose webhook has not arrived (yet). */
  @Interval(60_000)
  async reconcile(): Promise<void> {
    if (!this.config.paymentsConfigured) return;
    const now = Date.now();
    for (const member of this.store.members()) {
      if (member.cardStatus === 'pending' && now - Date.parse(member.setupStartedAt ?? '') < SETUP_WATCH_MS) {
        await this.sync(member.id);
      }
      for (const charge of member.charges.filter((candidate) => candidate.status === 'processing')) {
        await this.refreshCharge(member.id, charge.id);
      }
    }
  }

  private applySavedCard(id: string, facts: SavedCardFacts, source: 'lookup' | 'webhook'): Promise<Member> {
    return this.change(id, (member) => {
      if (member.customerId && member.customerId !== facts.customerId) {
        this.logger.warn(`${member.reference}: saved card belongs to another customer; ignored`);
        return;
      }
      if (member.cardStatus === 'active' && member.card) {
        if (member.card.paymentMethodId !== facts.paymentMethodId) {
          this.logger.log(`${member.reference} already has a card; another saved card is not used`);
          return;
        }
        // The same card again (lookup, then webhook): fill in anything the first source lacked.
        member.card.brand ??= facts.brand ?? undefined;
        member.card.last4 ??= facts.last4 ?? undefined;
        member.card.expMonth ??= facts.expMonth ?? undefined;
        member.card.expYear ??= facts.expYear ?? undefined;
        return;
      }
      const card: SavedCard = {
        paymentMethodId: facts.paymentMethodId,
        brand: facts.brand ?? undefined,
        last4: facts.last4 ?? undefined,
        expMonth: facts.expMonth ?? undefined,
        expYear: facts.expYear ?? undefined,
        savedAt: facts.savedAt ?? new Date().toISOString(),
        learnedFrom: source,
      };
      member.customerId = facts.customerId;
      member.card = card;
      member.cardStatus = 'active';
      this.logger.log(`${member.reference} saved a card (${card.brand ?? 'card'} ${card.last4 ?? ''}, via ${source})`);
    });
  }

  private applyPaymentState(
    memberId: string,
    chargeId: string,
    payment: PaymentState,
    source: 'lookup' | 'webhook',
  ): Promise<Member> {
    return this.changeCharge(memberId, chargeId, (charge) => {
      // Only this charge's payment, for exactly the membership amount, settles it.
      if (
        (charge.paymentId && charge.paymentId !== payment.id) ||
        payment.reference !== charge.reference ||
        !isAmount(payment.amount, charge.amount, charge.currency)
      ) {
        this.logger.warn(`Payment for ${charge.reference} does not match the charge; ignored`);
        return;
      }
      charge.paymentId = payment.id;
      switch (payment.status) {
        case 'paid':
          if (charge.status === 'paid' || charge.status === 'reversed') return;
          charge.status = 'paid';
          charge.failureCode = undefined;
          charge.paidAt = payment.paidAt ?? new Date().toISOString();
          charge.confirmedBy = source;
          this.logger.log(`${charge.reference} paid (confirmed by ${source})`);
          return;
        case 'failed':
        case 'expired':
        case 'cancelled':
          if (charge.status !== 'requesting' && charge.status !== 'processing') return;
          charge.status = 'failed';
          charge.failureCode = payment.failureCode ?? payment.status.toUpperCase();
          this.logger.warn(`${charge.reference} failed (${charge.failureCode})`);
          return;
        case 'reversed':
          charge.status = 'reversed';
          this.logger.warn(`${charge.reference} reversed by the bank`);
          return;
        default:
          if (charge.status === 'requesting') charge.status = 'processing';
      }
    });
  }

  /** The charge a payment is about: by SettleKing's payment id, or (before it was stored) by reference. */
  private findCharge(paymentId: string, reference: string): { member: Member; charge: MemberCharge } | undefined {
    for (const member of this.store.members()) {
      const charge =
        member.charges.find((candidate) => candidate.paymentId === paymentId) ??
        member.charges.find((candidate) => !candidate.paymentId && candidate.reference === reference);
      if (charge) return { member, charge };
    }
    return undefined;
  }

  private changeCharge(memberId: string, chargeId: string, mutate: (charge: MemberCharge) => void): Promise<Member> {
    return this.change(memberId, (member) => {
      const charge = member.charges.find((candidate) => candidate.id === chargeId);
      if (!charge) throw new NotFoundException('Charge not found');
      mutate(charge);
      charge.updatedAt = new Date().toISOString();
    });
  }

  private change(id: string, mutate: (member: Member) => void): Promise<Member> {
    return this.store.update((data) => {
      const member = data.members.find((candidate) => candidate.id === id);
      if (!member) throw new NotFoundException('Member not found');
      mutate(member);
      member.updatedAt = new Date().toISOString();
      return member;
    });
  }

  private requireCharge(id: string, chargeId: string): MemberCharge {
    const charge = this.require(id).charges.find((candidate) => candidate.id === chargeId);
    if (!charge) throw new NotFoundException('Charge not found');
    return charge;
  }

  private require(id: string): Member {
    const member = this.store.member(id);
    if (!member) throw new NotFoundException('Member not found');
    return member;
  }
}

function dollars(cents: number): string {
  return `$${toMoney(cents, 'USD').value.replace(/\.00$/, '')}`;
}
