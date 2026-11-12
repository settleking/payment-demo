/** SettleKing merchant API shapes used by the studio. */

/**
 * An amount of money: an ISO 4217 currency code and a decimal string in major units, e.g.
 * { currency: 'USD', value: '25.00' }. A string, so it is never parsed as a float.
 */
export interface Money {
  currency: string;
  value: string;
}

export interface CreateCheckoutRequest {
  reference: string;
  amount: Money;
  merchantName: string;
  description?: string;
  returnUrl?: string;
  /** Narrows the checkout to some of the merchant's enabled methods (uppercase on the wire). */
  paymentMethods?: ('CARD' | 'WALLET')[];
  /** ISO instant, at most seven days ahead; SettleKing's default applies when omitted. */
  expiresAt?: string;
}

/** The session as returned when it is created. */
export interface CreatedCheckout {
  id: string;
  reference: string;
  amount: Money;
  status: CheckoutStatus;
  returnUrl?: string;
  paymentMethods: string[];
}

/** The session as the merchant server reads it back. */
export interface MerchantCheckout {
  id: string;
  reference: string;
  amount: Money;
  status: CheckoutStatus;
  paymentMethods: string[];
  description?: string | null;
  returnUrl?: string | null;
  /** ISO-8601 after SettleKingClient normalizes it (the API sends epoch seconds). */
  createdAt: string;
  expiresAt: string;
  paidAt?: string | null;
  providerTransactionId?: string | null;
}

export type CheckoutStatus = 'open' | 'processing' | 'paid' | 'expired' | 'cancelled' | 'reversed' | 'failed';

/** How the payer paid: on the hosted page (card, wallet) or in an embedded widget (card, ACH). */
export type PaymentMethodName = 'card' | 'wallet' | 'ach';

/**
 * A payment as the merchant server reads it from {@code GET /payments/{id}}: a checkout opened by
 * hosted checkout, a widget, or a merchant-initiated charge of a saved card.
 */
export interface MerchantPayment extends MerchantCheckout {
  origin?: 'hosted' | 'widget' | 'merchant_initiated' | 'agreement' | null;
  customerId?: string | null;
  paymentMethodId?: string | null;
  /** Why a merchant-initiated charge failed, e.g. CARD_DECLINED. */
  failureCode?: string | null;
}

/**
 * Who a widget session (or a saved card) belongs to: an existing SettleKing customer id, or the
 * studio's own reference for the customer (created on first use, its email and name kept current).
 */
export type CustomerInput = { id: string } | { reference: string; email?: string; name?: string };

export type SavePaymentMethod = 'off' | 'optional' | 'required';

export interface CreateWidgetSessionRequest {
  widgetId: string;
  /** agreement: presents one pending payment agreement for approval (agreementId only). */
  mode: 'payment' | 'setup' | 'agreement';
  /** Agreement mode only: the pending agreement the customer approves. */
  agreementId?: string;
  /** Payment only (required there). */
  amount?: Money;
  /** Payment only (required there): the studio's order reference. */
  reference?: string;
  description?: string;
  /** Required for setup, and whenever the card may be saved. */
  customer?: CustomerInput;
  /** Payment only; saving needs the merchant-initiated payments capability. */
  savePaymentMethod?: SavePaymentMethod;
  paymentMethods?: ('card' | 'ach')[];
  /** Pins the session to one of the widget's allowed origins. */
  origin?: string;
  /** 60 to 3600; SettleKing's default is 1800. */
  expiresInSeconds?: number;
}

export type WidgetSessionStatus = 'open' | 'processing' | 'succeeded' | 'failed' | 'expired';

/** A widget session; its clientSecret is handed to the browser, nothing else is. */
export interface WidgetSession {
  id: string;
  widgetId: string;
  mode: 'payment' | 'setup' | 'agreement';
  agreementId?: string | null;
  status: WidgetSessionStatus;
  /** "wss_..." while the session is open, then null. */
  clientSecret: string | null;
  /** ISO-8601 after SettleKingClient normalizes it. */
  expiresAt: string | null;
  amount: Money | null;
  reference: string | null;
  /** Payment mode: the checkout the widget pays; read it for the outcome. */
  checkoutSessionId: string | null;
  customerId: string | null;
  savePaymentMethod: SavePaymentMethod | null;
  paymentMethods: string[];
  /** The card this session saved, once it succeeded with a save. */
  paymentMethodId: string | null;
  failureCode: string | null;
  createdAt: string | null;
  completedAt: string | null;
}

export interface CustomerPaymentMethod {
  id: string;
  customerId: string;
  type: 'card';
  brand?: string | null;
  last4?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  status: 'active' | 'detached';
}

/** A merchant-initiated charge of a saved card ({@code POST /payments}). */
export interface CreatePaymentRequest {
  customerId: string;
  paymentMethodId: string;
  amount: Money;
  reference: string;
  description?: string;
  merchantName?: string;
}

/** The body of every SettleKing webhook (Standard Webhooks signed). */
export interface SettleKingWebhook<T = Record<string, unknown>> {
  id: string;
  type: string;
  createdAt: string;
  provider: string;
  resourceId: string | null;
  status: string;
  data: T;
}

/** {@code data} of a MERCHANT_PAYMENT_RECEIVED webhook. */
export interface PaymentReceived {
  checkoutSessionId: string;
  reference: string;
  amount: Money;
  paymentMethod: PaymentMethodName;
  providerTransactionId: string | null;
  paidAt: string;
  origin?: 'hosted' | 'widget' | 'merchant_initiated' | 'agreement';
  customerId?: string;
  paymentMethodId?: string;
}

export const PAYMENT_RECEIVED = 'MERCHANT_PAYMENT_RECEIVED';

/** {@code data} of a MERCHANT_PAYMENT_FAILED webhook: a merchant-initiated charge was declined. */
export interface PaymentFailed {
  checkoutSessionId: string;
  reference: string;
  amount: Money;
  failureCode: string | null;
  failedAt: string;
  origin?: 'hosted' | 'widget' | 'merchant_initiated' | 'agreement';
  customerId?: string;
  paymentMethodId?: string;
}

export const PAYMENT_FAILED = 'MERCHANT_PAYMENT_FAILED';

/** {@code data} of a MERCHANT_PAYMENT_METHOD_SAVED webhook: a customer saved a card in a widget. */
export interface PaymentMethodSaved {
  customerId: string;
  customerReference: string | null;
  paymentMethodId: string;
  type: 'card';
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  widgetSessionId: string | null;
  savedAt: string;
}

export const PAYMENT_METHOD_SAVED = 'MERCHANT_PAYMENT_METHOD_SAVED';

/**
 * {@code data} of a MERCHANT_PAYMENT_REVERSED webhook: a paid checkout whose money the payer's bank
 * took back (an ACH return or a card chargeback). The checkout's status is now {@code reversed}.
 */
export interface PaymentReversed {
  checkoutSessionId: string;
  reference: string;
  amount: Money;
  /** What the bank took back, when the provider reported it. */
  reversedAmount: Money | null;
  reason: 'ACH_RETURN' | 'ACH_LATE_RETURN' | 'CHARGEBACK';
  providerTransactionId: string;
  reversedAt: string;
}

export const PAYMENT_REVERSED = 'MERCHANT_PAYMENT_REVERSED';

/**
 * A payment agreement: the customer's standing permission, approved once on SettleKing, for the
 * studio to charge them on a schedule (recurring) or when it needs to (on_demand), within limits.
 */
export type AgreementType = 'recurring' | 'on_demand';
export type AgreementStatus = 'pending' | 'active' | 'suspended' | 'cancelled' | 'expired';
/** `minute` exists only in SettleKing's test environments (every 10 to 1440 minutes). */
export type AgreementInterval = 'minute' | 'day' | 'week' | 'month' | 'year';

export interface CreateAgreementRequest {
  type: AgreementType;
  /** Printable ASCII, at most 100 characters. */
  reference: string;
  description?: string;
  merchantName?: string;
  /** recurring: the amount of every charge. */
  amount?: Money;
  interval?: AgreementInterval;
  intervalCount?: number;
  /** recurring: ISO instant of the first charge (a free trial); default on approval. */
  firstChargeAt?: string;
  /** on_demand: the most one charge may be. */
  maxAmountPerCharge?: Money;
  /** on_demand: the most all charges in a calendar month (UTC) may add up to. */
  maxAmountPerMonth?: Money;
  paymentMethods?: ('wallet' | 'card')[];
  /** Where the approval page sends the customer back to; https only. */
  returnUrl?: string;
  /** Only the SettleKing account that verified this email can approve the agreement. */
  payerEmail?: string;
  expiresInSeconds?: number;
}

export interface AgreementFunding {
  method: 'wallet' | 'card';
  cardBrand?: string | null;
  cardLast4?: string | null;
}

/** An agreement as the merchant reads it; instants are ISO after SettleKingClient normalizes them. */
export interface Agreement {
  id: string;
  status: AgreementStatus;
  type: AgreementType;
  reference: string;
  description?: string | null;
  merchantName?: string | null;
  amount?: Money | null;
  interval?: AgreementInterval | null;
  intervalCount?: number | null;
  maxAmountPerCharge?: Money | null;
  maxAmountPerMonth?: Money | null;
  paymentMethods: string[];
  /** Where the customer approves it (pending only). */
  approvalUrl?: string | null;
  requestExpiresAt?: string | null;
  funding?: AgreementFunding | null;
  chargedThisMonth?: Money | null;
  nextChargeAt?: string | null;
  cycle?: number | null;
  createdAt?: string | null;
  activatedAt?: string | null;
  endedAt?: string | null;
  endedBy?: 'payer' | 'merchant' | 'system' | null;
  endReason?: string | null;
}

export type AgreementChargeStatus = 'processing' | 'succeeded' | 'failed' | 'rejected';

/** One charge under an agreement. */
export interface AgreementCharge {
  id: string;
  agreementId: string;
  status: AgreementChargeStatus;
  amount: Money;
  cycle?: number | null;
  attempt: number;
  fundingMethod?: 'wallet' | 'card' | null;
  /** The wallet was short and the customer's bank covered the rest first. */
  viaDeposit: boolean;
  failureCode?: string | null;
  failureMessage?: string | null;
  initiatedBy: 'schedule' | 'merchant_api' | 'merchant';
  reference?: string | null;
  description?: string | null;
  /** The checkout the charge was paid through; payment webhooks carry it. */
  checkoutSessionId?: string | null;
  createdAt?: string | null;
  completedAt?: string | null;
}

/** A charge the studio asks for under an on-demand agreement. */
export interface CreateAgreementChargeRequest {
  amount: Money;
  reference?: string;
  description?: string;
}

/** {@code data} of a MERCHANT_AGREEMENT_UPDATED webhook: an agreement changed status. */
export interface AgreementUpdated {
  agreementId: string;
  reference: string;
  type: AgreementType;
  status: AgreementStatus;
  fundingMethod: 'wallet' | 'card' | null;
  endedBy: 'payer' | 'merchant' | 'system' | null;
  endReason: string | null;
  nextChargeAt: string | null;
  updatedAt: string;
}

export const AGREEMENT_UPDATED = 'MERCHANT_AGREEMENT_UPDATED';
