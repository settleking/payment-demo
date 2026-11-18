import type {
  AgreementChargeStatus,
  AgreementFunding,
  AgreementStatus,
  AgreementType,
} from '../settleking/settleking.types';

/**
 * A customer's plan at the studio: one SettleKing payment agreement. SettleKing holds the
 * customer's approval and makes every charge; the studio keeps the agreement id and a copy of what
 * SettleKing last reported.
 *
 * {@code proposing}: recorded, SettleKing's answer not stored yet (a retry reuses the same
 * Idempotency-Key, so it cannot create a second agreement). Then SettleKing's own statuses.
 */
export type PlanStatus = 'proposing' | AgreementStatus;

export interface PlanCharge {
  /** SettleKing's charge id; absent while the studio's request has no answer yet. */
  id?: string;
  status: AgreementChargeStatus | 'requesting';
  /** Cents: the price, without the card or bank fee. */
  amount: number;
  /** Cents: the card or bank fee SettleKing added on top (0 when none). */
  fee?: number;
  /** Cents: what the customer paid, amount + fee. */
  totalCharged?: number;
  cycle?: number | null;
  attempt?: number;
  reference?: string | null;
  description?: string | null;
  fundingMethod?: 'wallet' | 'card' | 'ach' | null;
  viaDeposit?: boolean;
  failureCode?: string | null;
  failureMessage?: string | null;
  initiatedBy?: string;
  checkoutSessionId?: string | null;
  /** On-demand requests from the studio: the key a retry resends. */
  idempotencyKey?: string;
  createdAt: string;
  completedAt?: string | null;
}

export interface Subscription {
  id: string;
  /** Human reference, also the agreement reference at SettleKing, e.g. TDS-P1007. */
  reference: string;
  planId: string;
  type: AgreementType;
  name: string;
  email: string;
  /** How the customer was sent to approve: SettleKing's page, or the widget in the studio's page. */
  approvedVia: 'hosted' | 'widget';
  /** The customer chose to set it up without a SettleKing account (email only). */
  withoutAccount?: boolean;
  /** SettleKing: approved without an account, so the studio manages it. */
  guest?: boolean;
  /** Cents a card or bank account adds to each charge, per SettleKing. */
  fees?: { card: number; ach: number } | null;
  agreementId?: string;
  approvalUrl?: string | null;
  widgetSessionId?: string;
  status: PlanStatus;
  funding?: AgreementFunding | null;
  nextChargeAt?: string | null;
  cycle?: number | null;
  /** Cents charged (succeeded or processing) this calendar month, per SettleKing. */
  chargedThisMonth?: number;
  requestExpiresAt?: string | null;
  endedBy?: string | null;
  endReason?: string | null;
  /** Newest first. */
  charges: PlanCharge[];
  /** On-demand charges requested so far; part of the next one's reference and key. */
  chargeRequests: number;
  /** Set when SettleKing's agreement and charges were last read. */
  syncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** What the customer's own browser sees (by the plan's unguessable id). */
export function customerView(plan: Subscription) {
  return {
    id: plan.id,
    reference: plan.reference,
    planId: plan.planId,
    type: plan.type,
    name: plan.name,
    status: plan.status,
    approvedVia: plan.approvedVia,
    approvalUrl: plan.status === 'pending' ? plan.approvalUrl : undefined,
    withoutAccount: plan.withoutAccount ?? false,
    guest: plan.guest ?? false,
    fees: plan.fees ?? null,
    funding: plan.funding,
    nextChargeAt: plan.nextChargeAt,
    chargedThisMonth: plan.chargedThisMonth,
    endedBy: plan.endedBy,
    charges: plan.charges.slice(0, 12).map(({ idempotencyKey: _key, ...charge }) => charge),
    createdAt: plan.createdAt,
  };
}

/** What the studio admin sees. */
export function adminPlanView(plan: Subscription) {
  return {
    ...customerView(plan),
    email: plan.email,
    agreementId: plan.agreementId,
    cycle: plan.cycle,
    endReason: plan.endReason,
    requestExpiresAt: plan.requestExpiresAt,
    chargeRequests: plan.chargeRequests,
    syncedAt: plan.syncedAt,
    charges: plan.charges.slice(0, 20).map(({ idempotencyKey: _key, ...charge }) => charge),
  };
}
