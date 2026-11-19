import type { PaymentMethodName } from '../settleking/settleking.types';

/** A class booking and its payment state. */
export type BookingStatus = 'pending_payment' | 'paid' | 'payment_reversed' | 'refunded' | 'expired' | 'cancelled';

export interface Booking {
  id: string;
  /** Human reference, also the SettleKing checkout reference, e.g. TDS-1042. */
  reference: string;
  classId: string;
  title: string;
  studentName: string;
  email: string;
  amount: number;
  currency: 'USD';
  status: BookingStatus;
  /** Where the customer pays: SettleKing's hosted page, or the widget embedded in this page. */
  channel?: 'hosted' | 'widget';
  /** The checkout that pays this booking (both channels; a widget payment opens one too). */
  checkoutSessionId?: string;
  checkoutUrl?: string;
  /** The widget session that renders the payment form ("Pay here" only). */
  widgetSessionId?: string;
  /** SettleKing's customer for this email ("Pay here" only); a card the customer saves belongs to it. */
  customerId?: string;
  paymentMethod?: PaymentMethodName;
  /** The gateway's (NMI's) id for the sale: what the studio sees in its NMI portal. */
  providerTransactionId?: string;
  /** Cents of card or bank fee the customer paid on top of the price. */
  fee?: number;
  /** Cents refunded so far, and each refund SettleKing reported (by its refund id). */
  refundedAmount?: number;
  refundIds?: string[];
  paidAt?: string;
  /** Which path confirmed the payment first: the signed webhook or the server-side lookup. */
  confirmedBy?: 'webhook' | 'lookup';
  createdAt: string;
  updatedAt: string;
}

/** What the customer's browser may see about a booking. */
export function publicView(booking: Booking) {
  return {
    id: booking.id,
    reference: booking.reference,
    title: booking.title,
    studentName: booking.studentName,
    amount: booking.amount,
    currency: booking.currency,
    status: booking.status,
    channel: booking.channel ?? 'hosted',
    checkoutUrl: booking.status === 'pending_payment' ? booking.checkoutUrl : undefined,
    paymentMethod: booking.paymentMethod,
    paidAt: booking.paidAt,
  };
}

/** What the studio admin sees about a booking. */
export function adminBookingView(booking: Booking) {
  return {
    ...publicView(booking),
    email: booking.email,
    checkoutSessionId: booking.checkoutSessionId,
    providerTransactionId: booking.providerTransactionId,
    fee: booking.fee ?? 0,
    refundedAmount: booking.refundedAmount ?? 0,
    confirmedBy: booking.confirmedBy,
    createdAt: booking.createdAt,
  };
}
