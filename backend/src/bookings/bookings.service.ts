import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { randomUUID } from 'node:crypto';

import { DanceClass, findClass } from '../catalog/catalog.data';
import { AppConfig } from '../config';
import { isAmount, toMoney } from '../settleking/money';
import { isCapabilityMissing, SettleKingClient, SettleKingError } from '../settleking/settleking.client';
import {
  Money,
  PAYMENT_FAILED,
  PAYMENT_RECEIVED,
  PAYMENT_REVERSED,
  PaymentFailed,
  PaymentMethodName,
  PaymentReceived,
  PaymentReversed,
  SavePaymentMethod,
  SettleKingWebhook,
  WidgetSession,
} from '../settleking/settleking.types';
import { JsonStore } from '../storage/json-store';
import { Booking, publicView } from './booking.model';
import { CreateBookingDto } from './dto/create-booking.dto';

/** The facts of a completed payment, from the webhook or a checkout lookup. */
interface PaymentFacts {
  checkoutSessionId: string;
  reference: string;
  amount: Money;
  paymentMethod?: PaymentMethodName;
  providerTransactionId?: string | null;
  paidAt?: string | null;
}

/** How the page continues: to the hosted page (checkoutUrl), or with the widget (clientSecret). */
export interface StartedPayment {
  bookingId: string;
  checkoutUrl?: string;
  clientSecret?: string;
}

/** After SettleKing says the studio may not save cards, ask again only this much later. */
const CAPABILITY_RECHECK_MS = 10 * 60_000;

/**
 * Books classes and gets them paid through SettleKing, on the hosted checkout page or in the
 * widget embedded in the studio's page. A payment is confirmed by whichever arrives first: the
 * signed webhook, the server-side lookup when the customer returns (or the widget reports success),
 * or the one-minute sweep, so a lost webhook or a closed tab never loses a payment.
 */
@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);
  /** Until when "Pay here" offers no card saving because SettleKing refused it (0: try). */
  private savingRefusedUntil = 0;

  constructor(
    private readonly store: JsonStore,
    private readonly settleking: SettleKingClient,
    private readonly config: AppConfig,
  ) {}

  /** Records the booking, then opens a SettleKing checkout (hosted) or widget session for it. */
  async create(dto: CreateBookingDto): Promise<StartedPayment> {
    const item = findClass(dto.classId);
    if (!item) throw new BadRequestException('Choose a class');
    const channel = dto.payWith ?? 'hosted';
    if (channel === 'widget' && !this.config.widgetsConfigured) {
      throw new BadRequestException('Paying on this page is not available; continue to the payment page.');
    }
    const booking = await this.record(dto, item, channel);

    try {
      return channel === 'widget' ? await this.openWidget(booking) : await this.openCheckout(booking);
    } catch (error) {
      await this.change(booking.id, (current) => {
        current.status = 'cancelled';
      });
      this.logger.warn(`Payment for ${booking.reference} could not start: ${(error as Error).message}`);
      if (error instanceof SettleKingError && error.code === 'NOT_CONFIGURED') {
        throw new ServiceUnavailableException('Online payments are not set up yet.');
      }
      throw new BadGatewayException(
        channel === 'widget'
          ? 'We could not open the payment form. Please try again.'
          : 'We could not open the payment page. Please try again.',
      );
    }
  }

  get(id: string) {
    return publicView(this.require(id));
  }

  /** Asks SettleKing for the checkout's state, server to server; the browser is never trusted. */
  async sync(id: string) {
    const booking = this.require(id);
    if (booking.status !== 'pending_payment' || !booking.checkoutSessionId) return publicView(booking);
    try {
      const session = await this.settleking.getCheckout(booking.checkoutSessionId);
      if (session.status === 'paid') {
        await this.applyPayment(id, { ...session, checkoutSessionId: session.id }, 'lookup');
      } else if (session.status === 'expired' || session.status === 'cancelled') {
        await this.close(id, session.status);
      } else if (session.status === 'open' && booking.widgetSessionId) {
        // An unpaid widget payment ends with its widget session: nobody else can pay that checkout.
        const widget = await this.settleking.getWidgetSession(booking.widgetSessionId);
        if (widget.status === 'expired') await this.close(id, 'expired');
      }
    } catch (error) {
      this.logger.warn(`Checkout lookup for ${booking.reference} failed: ${(error as Error).message}`);
    }
    return publicView(this.require(id));
  }

  /**
   * Applies a verified, first-seen webhook to the booking it is about. Returns the booking's
   * reference when it applied, or undefined when the event is not about a booking.
   */
  async handleWebhook(event: SettleKingWebhook): Promise<string | undefined> {
    const checkoutSessionId = (event.data as { checkoutSessionId?: string }).checkoutSessionId;
    const booking = checkoutSessionId ? this.store.bookingByCheckout(checkoutSessionId) : undefined;
    if (!booking) return undefined;
    switch (event.type) {
      case PAYMENT_RECEIVED:
        await this.applyPayment(booking.id, event.data as unknown as PaymentReceived, 'webhook');
        return booking.reference;
      case PAYMENT_REVERSED:
        await this.applyReversal(booking.id, event.data as unknown as PaymentReversed);
        return booking.reference;
      case PAYMENT_FAILED: {
        // Declined cards in a widget can be retried there; the booking waits for a payment or expiry.
        const failed = event.data as unknown as PaymentFailed;
        this.logger.warn(`${booking.reference}: a payment attempt failed (${failed.failureCode ?? 'unknown'})`);
        return booking.reference;
      }
      default:
        return undefined;
    }
  }

  /** Every minute: settle bookings whose webhook has not arrived (yet). */
  @Interval(60_000)
  async reconcilePending(): Promise<void> {
    if (!this.config.paymentsConfigured) return;
    for (const booking of this.store.bookings().filter((b) => b.status === 'pending_payment' && b.checkoutSessionId)) {
      await this.sync(booking.id);
    }
  }

  private record(dto: CreateBookingDto, item: DanceClass, channel: 'hosted' | 'widget'): Promise<Booking> {
    const now = new Date().toISOString();
    return this.store.update((data) => {
      const created: Booking = {
        id: randomUUID(),
        reference: `TDS-${data.nextReference++}`,
        classId: item.id,
        title: item.title,
        studentName: dto.studentName,
        email: dto.email.toLowerCase(),
        amount: item.amount,
        currency: 'USD',
        status: 'pending_payment',
        channel,
        createdAt: now,
        updatedAt: now,
      };
      data.bookings.unshift(created);
      return created;
    });
  }

  /** Hosted checkout: the customer is sent to SettleKing's page and comes back to /?booking=<id>. */
  private async openCheckout(booking: Booking): Promise<StartedPayment> {
    const checkout = await this.settleking.createCheckout(
      {
        reference: booking.reference,
        amount: toMoney(booking.amount, booking.currency),
        merchantName: this.config.settleking.merchantName,
        ...(this.config.settleking.paymentMethods.length
          ? { paymentMethods: this.config.settleking.paymentMethods }
          : {}),
        description: this.description(booking),
        // SettleKing sends the customer back here after paying.
        returnUrl: `${this.config.publicUrl}/?booking=${booking.id}`,
      },
      // Safe to retry: the same key always returns the same checkout.
      booking.id,
    );
    const checkoutUrl = this.settleking.checkoutPageUrl(checkout.id);
    await this.change(booking.id, (current) => {
      current.checkoutSessionId = checkout.id;
      current.checkoutUrl = checkoutUrl;
    });
    return { bookingId: booking.id, checkoutUrl };
  }

  /**
   * "Pay here": a payment widget session for exactly this booking. The server decides the amount,
   * reference and customer; the browser only gets the session's client secret to render the form.
   * Customers may tick "save my card" when the studio is allowed to keep cards; SettleKing refuses
   * with 403 CAPABILITY_NOT_ENABLED otherwise, and the session is opened without saving.
   */
  private async openWidget(booking: Booking): Promise<StartedPayment> {
    const open = (savePaymentMethod: SavePaymentMethod) =>
      this.settleking.createWidgetSession(
        {
          widgetId: this.config.settleking.widgetId,
          mode: 'payment',
          amount: toMoney(booking.amount, booking.currency),
          reference: booking.reference,
          description: this.description(booking),
          customer: { reference: booking.email, email: booking.email, name: booking.studentName },
          savePaymentMethod,
        },
        // Safe to retry; a refused request (403) stores nothing, so the fallback may reuse the key.
        `${booking.id}-widget`,
      );

    let session: WidgetSession;
    if (Date.now() < this.savingRefusedUntil) {
      session = await open('off');
    } else {
      try {
        session = await open('optional');
      } catch (error) {
        if (!isCapabilityMissing(error)) throw error;
        this.savingRefusedUntil = Date.now() + CAPABILITY_RECHECK_MS;
        this.logger.log('Saving cards is not enabled for this studio; "Pay here" opens without it');
        session = await open('off');
      }
    }
    if (!session.clientSecret || !session.checkoutSessionId) {
      throw new SettleKingError(`Widget session ${session.id} is ${session.status}`, 409, 'WIDGET_SESSION_CLOSED');
    }
    await this.change(booking.id, (current) => {
      current.widgetSessionId = session.id;
      current.checkoutSessionId = session.checkoutSessionId ?? undefined;
      current.customerId = session.customerId ?? undefined;
    });
    return { bookingId: booking.id, clientSecret: session.clientSecret };
  }

  private description(booking: Booking): string {
    return `${booking.title} for ${booking.studentName}`;
  }

  private close(id: string, status: 'expired' | 'cancelled'): Promise<Booking> {
    return this.change(id, (current) => {
      if (current.status === 'pending_payment') current.status = status;
    });
  }

  private applyPayment(id: string, payment: PaymentFacts, source: 'webhook' | 'lookup'): Promise<Booking> {
    return this.change(id, (booking) => {
      if (booking.status === 'paid') {
        booking.paymentMethod ??= payment.paymentMethod;
        return;
      }
      // Only the checkout this booking opened, for exactly this booking and what it costs, confirms it.
      if (
        booking.checkoutSessionId !== payment.checkoutSessionId ||
        payment.reference !== booking.reference ||
        !isAmount(payment.amount, booking.amount, booking.currency)
      ) {
        this.logger.warn(`Payment for ${booking.reference} does not match its checkout; ignored`);
        return;
      }
      booking.status = 'paid';
      booking.paymentMethod = payment.paymentMethod;
      booking.providerTransactionId = payment.providerTransactionId ?? undefined;
      booking.paidAt = payment.paidAt ?? new Date().toISOString();
      booking.confirmedBy = source;
      this.logger.log(`${booking.reference} paid (confirmed by ${source})`);
    });
  }

  /**
   * The payer's bank took the money back (ACH return, chargeback): the class is no longer paid for.
   * Whether to cancel the place or ask for another payment is the studio's decision; this sample
   * only marks it.
   */
  private applyReversal(id: string, reversal: PaymentReversed): Promise<Booking> {
    return this.change(id, (booking) => {
      if (booking.checkoutSessionId !== reversal.checkoutSessionId || booking.status !== 'paid') return;
      booking.status = 'payment_reversed';
      this.logger.warn(`${booking.reference} payment reversed (${reversal.reason})`);
    });
  }

  private change(id: string, mutate: (booking: Booking) => void): Promise<Booking> {
    return this.store.update((data) => {
      const booking = data.bookings.find((candidate) => candidate.id === id);
      if (!booking) throw new NotFoundException('Booking not found');
      mutate(booking);
      booking.updatedAt = new Date().toISOString();
      return booking;
    });
  }

  private require(id: string): Booking {
    const booking = this.store.booking(id);
    if (!booking) throw new NotFoundException('Booking not found');
    return booking;
  }
}
