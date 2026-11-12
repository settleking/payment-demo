import { Injectable, Logger } from '@nestjs/common';

import { AppConfig } from '../config';
import {
  Agreement,
  AgreementCharge,
  CreateAgreementChargeRequest,
  CreateAgreementRequest,
  CreateCheckoutRequest,
  CreatedCheckout,
  CreatePaymentRequest,
  CreateWidgetSessionRequest,
  CustomerPaymentMethod,
  MerchantCheckout,
  MerchantPayment,
  WidgetSession,
} from './settleking.types';

/** A SettleKing API call that failed; {@code status} 0 means SettleKing could not be reached. */
export class SettleKingError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Whether SettleKing refused because the studio may not save cards or charge them later: the
 * merchant-initiated payments capability is granted by SettleKing operations, not self-service.
 */
export function isCapabilityMissing(error: unknown): boolean {
  return error instanceof SettleKingError && error.status === 403 && error.code === 'CAPABILITY_NOT_ENABLED';
}

/**
 * The studio's server-side SettleKing client. It authenticates with the API client created in
 * SettleKing's Developer setup (HTTP Basic) and never runs in the browser.
 */
@Injectable()
export class SettleKingClient {
  private readonly logger = new Logger(SettleKingClient.name);

  constructor(private readonly config: AppConfig) {}

  /**
   * Creates a hosted checkout. The same idempotency key always returns the same checkout, so a
   * retried booking never creates a second one.
   */
  createCheckout(request: CreateCheckoutRequest, idempotencyKey: string): Promise<CreatedCheckout> {
    return this.call<CreatedCheckout>('POST', '/checkout/sessions', request, {
      'Idempotency-Key': idempotencyKey,
    });
  }

  /** Reads a checkout back; only this merchant's checkouts are visible. */
  async getCheckout(id: string): Promise<MerchantCheckout> {
    const checkout = await this.call<MerchantCheckout>('GET', `/checkout/sessions/${encodeURIComponent(id)}`);
    return {
      ...checkout,
      createdAt: isoInstant(checkout.createdAt) ?? '',
      expiresAt: isoInstant(checkout.expiresAt) ?? '',
      paidAt: isoInstant(checkout.paidAt),
    };
  }

  /**
   * Opens a widget session: one rendering of an embedded widget, for one payment or one saved card.
   * Its clientSecret is the only part the browser gets. The same idempotency key returns the same
   * session.
   */
  async createWidgetSession(request: CreateWidgetSessionRequest, idempotencyKey: string): Promise<WidgetSession> {
    return normalizeWidgetSession(
      await this.call<WidgetSession>('POST', '/widget-sessions', request, { 'Idempotency-Key': idempotencyKey }),
    );
  }

  /** Reads a widget session back: its status and, after a save, the card it saved. */
  async getWidgetSession(id: string): Promise<WidgetSession> {
    return normalizeWidgetSession(
      await this.call<WidgetSession>('GET', `/widget-sessions/${encodeURIComponent(id)}`),
    );
  }

  /** Reads any payment of this merchant (hosted, widget or merchant-initiated) by its id. */
  async getPayment(id: string): Promise<MerchantPayment> {
    return normalizePayment(await this.call<MerchantPayment>('GET', `/payments/${encodeURIComponent(id)}`));
  }

  /**
   * Charges a customer's saved card now. SettleKing answers 202 with the payment `processing`; the
   * outcome arrives by webhook and from {@link getPayment}. The same key never charges twice.
   */
  async createPayment(request: CreatePaymentRequest, idempotencyKey: string): Promise<MerchantPayment> {
    return normalizePayment(
      await this.call<MerchantPayment>('POST', '/payments', request, { 'Idempotency-Key': idempotencyKey }),
    );
  }

  /** The customer's active saved cards. */
  customerPaymentMethods(customerId: string): Promise<CustomerPaymentMethod[]> {
    return this.call<CustomerPaymentMethod[]>('GET', `/customers/${encodeURIComponent(customerId)}/payment-methods`);
  }

  /** Removes a saved card; SettleKing will never charge it again. */
  detachPaymentMethod(customerId: string, paymentMethodId: string): Promise<CustomerPaymentMethod> {
    return this.call<CustomerPaymentMethod>(
      'DELETE',
      `/customers/${encodeURIComponent(customerId)}/payment-methods/${encodeURIComponent(paymentMethodId)}`,
    );
  }

  /**
   * Proposes a payment agreement. SettleKing answers with its approvalUrl; nothing is charged until
   * the customer approves it on SettleKing. The same key returns the same agreement.
   */
  async createAgreement(request: CreateAgreementRequest, idempotencyKey: string): Promise<Agreement> {
    return normalizeAgreement(
      await this.call<Agreement>('POST', '/agreements', request, { 'Idempotency-Key': idempotencyKey }),
    );
  }

  async getAgreement(id: string): Promise<Agreement> {
    return normalizeAgreement(await this.call<Agreement>('GET', `/agreements/${encodeURIComponent(id)}`));
  }

  /** The agreement's newest charges (one page). */
  async agreementCharges(id: string, size = 50): Promise<AgreementCharge[]> {
    const page = await this.call<{ content: AgreementCharge[] }>(
      'GET',
      `/agreements/${encodeURIComponent(id)}/charges?page=0&size=${size}`,
    );
    return (page.content ?? []).map(normalizeCharge);
  }

  /**
   * Charges an on-demand agreement. A charge outside the limits, or one the customer cannot cover,
   * answers `rejected` with a failureCode and moves no money. The same key never charges twice.
   */
  async chargeAgreement(
    id: string,
    request: CreateAgreementChargeRequest,
    idempotencyKey: string,
  ): Promise<AgreementCharge> {
    return normalizeCharge(
      // Starting a wallet charge that tops up from the customer's bank takes longer than most calls.
      await this.call<AgreementCharge>(
        'POST',
        `/agreements/${encodeURIComponent(id)}/charges`,
        request,
        { 'Idempotency-Key': idempotencyKey },
        60_000,
      ),
    );
  }

  /** Ends the agreement; nothing more is charged. Cancelling an ended agreement returns it unchanged. */
  async cancelAgreement(id: string, reason: string, idempotencyKey: string): Promise<Agreement> {
    return normalizeAgreement(
      await this.call<Agreement>('POST', `/agreements/${encodeURIComponent(id)}/cancel`, { reason }, {
        'Idempotency-Key': idempotencyKey,
      }),
    );
  }

  /** Where to send the customer to pay. */
  checkoutPageUrl(id: string): string {
    return `${this.config.settleking.checkoutUrl}/${encodeURIComponent(id)}`;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    const { apiUrl, clientId, clientSecret } = this.config.settleking;
    if (!clientId || !clientSecret) {
      throw new SettleKingError('SettleKing API credentials are not configured', 0, 'NOT_CONFIGURED');
    }
    const url = `${apiUrl}/api/v1/payments/merchant/integrations${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      this.logger.warn(`SettleKing unreachable: ${method} ${path}: ${(error as Error).message}`);
      throw new SettleKingError('SettleKing could not be reached', 0, 'UNREACHABLE');
    }
    const payload = (await response.json().catch(() => null)) as
      | { response?: T; message?: string; errorCode?: string; error?: string }
      | null;
    if (!response.ok || !payload?.response) {
      const message = payload?.message ?? payload?.error ?? response.statusText;
      this.logger.warn(`SettleKing ${method} ${path} -> ${response.status} ${message}`);
      throw new SettleKingError(message || 'SettleKing request failed', response.status, payload?.errorCode);
    }
    return payload.response;
  }
}

function normalizePayment(payment: MerchantPayment): MerchantPayment {
  return {
    ...payment,
    createdAt: isoInstant(payment.createdAt) ?? '',
    expiresAt: isoInstant(payment.expiresAt) ?? '',
    paidAt: isoInstant(payment.paidAt),
  };
}

function normalizeAgreement(agreement: Agreement): Agreement {
  return {
    ...agreement,
    requestExpiresAt: isoInstant(agreement.requestExpiresAt),
    nextChargeAt: isoInstant(agreement.nextChargeAt),
    createdAt: isoInstant(agreement.createdAt),
    activatedAt: isoInstant(agreement.activatedAt),
    endedAt: isoInstant(agreement.endedAt),
  };
}

function normalizeCharge(charge: AgreementCharge): AgreementCharge {
  return { ...charge, createdAt: isoInstant(charge.createdAt), completedAt: isoInstant(charge.completedAt) };
}

function normalizeWidgetSession(session: WidgetSession): WidgetSession {
  return {
    ...session,
    expiresAt: isoInstant(session.expiresAt),
    createdAt: isoInstant(session.createdAt),
    completedAt: isoInstant(session.completedAt),
  };
}

/** SettleKing sends instants as epoch seconds (with a fraction) or ISO-8601; this returns ISO. */
export function isoInstant(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'number' ? new Date(value * 1000).toISOString() : new Date(value).toISOString();
}
