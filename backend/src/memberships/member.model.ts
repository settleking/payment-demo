/**
 * A monthly member: someone who saved a card with the studio through a SettleKing setup widget, so
 * the studio can charge the membership later without them present. The card itself stays with
 * SettleKing; the studio keeps only its id, brand and last four digits.
 */
export type CardStatus = 'none' | 'pending' | 'active' | 'removed';

export interface SavedCard {
  /** SettleKing's id for the saved card; charges name it. */
  paymentMethodId: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  savedAt: string;
  /** How the studio learned of it: the setup session lookup or the signed webhook. */
  learnedFrom: 'lookup' | 'webhook';
  removedAt?: string;
}

/**
 * One attempt to charge the membership. {@code requesting}: recorded, SettleKing's answer not yet
 * stored (a retry reuses the same Idempotency-Key, so it can never charge twice); {@code
 * processing}: SettleKing accepted it; {@code paid} / {@code failed}: the outcome; {@code reversed}:
 * the bank took a paid charge back.
 */
export type ChargeStatus = 'requesting' | 'processing' | 'paid' | 'failed' | 'reversed';

export interface MemberCharge {
  id: string;
  /** SettleKing's payment id, once it accepted the charge. */
  paymentId?: string;
  /** The billing month, e.g. 2026-10. */
  period: string;
  /** 1 for the month's first try, then 2, 3… after a failure. */
  attempt: number;
  /** member id + period + attempt: the same charge attempt always sends the same key. */
  idempotencyKey: string;
  /** The SettleKing payment reference, unique per attempt, e.g. TDS-M1003-2026-10-1. */
  reference: string;
  amount: number;
  currency: 'USD';
  status: ChargeStatus;
  failureCode?: string;
  paidAt?: string;
  confirmedBy?: 'webhook' | 'lookup';
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  /** Human reference, e.g. TDS-M1003. */
  reference: string;
  name: string;
  /** Lowercased; also the studio's customer reference at SettleKing. */
  email: string;
  /** SettleKing's customer for this email. */
  customerId?: string;
  /** The latest setup widget session (save a card). */
  setupSessionId?: string;
  setupStartedAt?: string;
  /** Setup sessions opened so far; part of the next one's Idempotency-Key. */
  setupAttempts: number;
  cardStatus: CardStatus;
  card?: SavedCard;
  /** Newest first. */
  charges: MemberCharge[];
  createdAt: string;
  updatedAt: string;
}

/** What the member's own browser may see. */
export function memberView(member: Member) {
  return {
    id: member.id,
    reference: member.reference,
    name: member.name,
    cardStatus: member.cardStatus,
    card:
      member.card && member.cardStatus === 'active'
        ? { brand: member.card.brand, last4: member.card.last4, expMonth: member.card.expMonth, expYear: member.card.expYear }
        : undefined,
  };
}

/** What the studio admin sees: everything the studio stores (it holds no card data or secrets). */
export function adminView(member: Member) {
  return {
    ...memberView(member),
    email: member.email,
    customerId: member.customerId,
    card: member.card,
    lastCharge: member.charges[0],
    charges: member.charges.slice(0, 12),
    createdAt: member.createdAt,
  };
}
