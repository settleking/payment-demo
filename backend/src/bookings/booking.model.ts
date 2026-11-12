import type { PaymentMethodName } from '../settleking/settleking.types';

/** A class booking and its payment state. */
export type BookingStatus = 'pending_payment' | 'paid' | 'payment_reversed' | 'expired' | 'cancelled';

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
  providerTransactionId?: string;
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
    confirmedBy: booking.confirmedBy,
    createdAt: booking.createdAt,
  };
}
