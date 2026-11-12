/** The studio API. Payments start server-side; the browser never sees API keys. */

export interface DanceClass {
  id: string;
  title: string;
  style: string;
  schedule: string;
  instructor: string;
  description: string;
  amount: number;
}

/** What the page needs to offer the embedded widget; `widget` is null when it is not set up. */
export interface SiteConfig {
  studioName: string;
  widget: { publishableKey: string; payUrl: string } | null;
  membership: { amount: number; currency: 'USD' };
  plans: Plan[];
  /** SettleKing's payment origin (approval pages, widget loader). */
  payUrl: string;
  /** SettleKing's app origin, where customers manage plans and limits. */
  appUrl: string;
}

/** A plan from the studio's catalog: a SettleKing payment agreement the customer approves once. */
export interface Plan {
  id: string;
  type: 'recurring' | 'on_demand';
  title: string;
  tagline: string;
  perks: string[];
  amount?: number;
  interval?: 'minute' | 'day' | 'week' | 'month' | 'year';
  /** Every this many intervals; 1 when absent. */
  intervalCount?: number;
  trialDays?: number;
  maxPerCharge?: number;
  maxPerMonth?: number;
}

export type PlanStatus = 'proposing' | 'pending' | 'active' | 'suspended' | 'cancelled' | 'expired';

export interface PlanCharge {
  id?: string;
  status: 'requesting' | 'processing' | 'succeeded' | 'failed' | 'rejected' | 'returned';
  amount: number;
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
  createdAt: string;
  completedAt?: string | null;
}

/** A customer's plan as their own browser sees it. */
export interface CustomerPlan {
  id: string;
  reference: string;
  planId: string;
  type: 'recurring' | 'on_demand';
  name: string;
  status: PlanStatus;
  approvedVia: 'hosted' | 'widget';
  approvalUrl?: string | null;
  funding?: { method: 'wallet' | 'card' | 'ach'; cardBrand?: string | null; cardLast4?: string | null } | null;
  nextChargeAt?: string | null;
  chargedThisMonth?: number;
  endedBy?: string | null;
  charges: PlanCharge[];
  createdAt: string;
}

/** A booking as the studio admin sees it. */
export interface AdminBooking extends Booking {
  email: string;
  checkoutSessionId?: string;
  confirmedBy?: 'webhook' | 'lookup';
  paidAt?: string;
  createdAt: string;
}

/** A plan as the studio admin sees it. */
export interface AdminPlan extends CustomerPlan {
  email: string;
  agreementId?: string;
  cycle?: number | null;
  endReason?: string | null;
  requestExpiresAt?: string | null;
  syncedAt?: string;
}

export interface Booking {
  id: string;
  reference: string;
  title: string;
  studentName: string;
  amount: number;
  status: 'pending_payment' | 'paid' | 'payment_reversed' | 'expired' | 'cancelled';
  channel: 'hosted' | 'widget';
  checkoutUrl?: string;
  paymentMethod?: 'card' | 'wallet' | 'ach';
}

/** How to continue after booking: the hosted page (checkoutUrl) or the widget (clientSecret). */
export interface StartedPayment {
  bookingId: string;
  checkoutUrl?: string;
  clientSecret?: string;
}

export interface CardSummary {
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
}

export interface Member {
  id: string;
  reference: string;
  name: string;
  cardStatus: 'none' | 'pending' | 'active' | 'removed';
  card?: CardSummary;
}

export interface MemberCharge {
  id: string;
  paymentId?: string;
  period: string;
  attempt: number;
  reference: string;
  amount: number;
  status: 'requesting' | 'processing' | 'paid' | 'failed' | 'reversed';
  failureCode?: string;
  paidAt?: string;
  createdAt: string;
}

/** A member as the studio admin sees it. */
export interface AdminMember extends Omit<Member, 'card'> {
  email: string;
  customerId?: string;
  card?: CardSummary & { paymentMethodId: string; removedAt?: string };
  lastCharge?: MemberCharge;
  charges: MemberCharge[];
  createdAt: string;
}

async function request<T>(path: string, init: RequestInit = {}, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = Array.isArray(payload?.message) ? payload.message.join('. ') : payload?.message;
    throw new Error(message || 'Something went wrong. Please try again.');
  }
  return payload as T;
}

export const api = {
  config: () => request<SiteConfig>('/config'),
  classes: () => request<DanceClass[]>('/classes'),
  book: (body: { classId: string; studentName: string; email: string; payWith: 'hosted' | 'widget' }) =>
    request<StartedPayment>('/bookings', { method: 'POST', body: JSON.stringify(body) }),
  booking: (id: string) => request<Booking>(`/bookings/${encodeURIComponent(id)}`),
  /** Asks the server to confirm the payment with SettleKing now. */
  syncBooking: (id: string) => request<Booking>(`/bookings/${encodeURIComponent(id)}/sync`, { method: 'POST' }),

  joinMembership: (body: { name: string; email: string }) =>
    request<{ memberId: string; clientSecret: string }>('/memberships', { method: 'POST', body: JSON.stringify(body) }),
  /** Proposes the plan; returns SettleKing's approval link (hosted) or a widget client secret. */
  startPlan: (body: { planId: string; name: string; email: string; approveVia: 'hosted' | 'widget' }) =>
    request<{ planId: string; approvalUrl?: string; clientSecret?: string }>('/plans', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  plan: (id: string) => request<CustomerPlan>(`/plans/${encodeURIComponent(id)}`),
  /** Asks the server to read the agreement from SettleKing now. */
  syncPlan: (id: string) => request<CustomerPlan>(`/plans/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
  cancelPlan: (id: string, email: string) =>
    request<CustomerPlan>(`/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ email }) }),

  /** Asks the server to confirm the saved card with SettleKing now. */
  syncMember: (id: string) => request<Member>(`/memberships/${encodeURIComponent(id)}/sync`, { method: 'POST' }),
};

/** The studio admin API; every call carries the admin token. */
export function adminApi(token: string) {
  const auth = { 'X-Admin-Token': token };
  const member = (id: string) => `/admin/members/${encodeURIComponent(id)}`;
  return {
    members: () => request<AdminMember[]>('/admin/members', {}, auth),
    charge: (id: string) => request<AdminMember>(`${member(id)}/charges`, { method: 'POST' }, auth),
    /** The server reads the payment from SettleKing (GET /payments/{id}) and returns the member. */
    refreshCharge: (id: string, chargeId: string) =>
      request<AdminMember>(`${member(id)}/charges/${encodeURIComponent(chargeId)}`, {}, auth),
    removeCard: (id: string) => request<AdminMember>(`${member(id)}/card`, { method: 'DELETE' }, auth),
    bookings: () => request<AdminBooking[]>('/admin/bookings', {}, auth),
    plans: () => request<AdminPlan[]>('/admin/plans', {}, auth),
    syncPlan: (id: string) => request<AdminPlan>(`/admin/plans/${encodeURIComponent(id)}/sync`, { method: 'POST' }, auth),
    chargePlan: (id: string, classId: string) =>
      request<AdminPlan>(`/admin/plans/${encodeURIComponent(id)}/charges`, { method: 'POST', body: JSON.stringify({ classId }) }, auth),
    cancelPlan: (id: string) => request<AdminPlan>(`/admin/plans/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, auth),
  };
}

export const money = (cents: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(cents / 100);

export const cardLabel = (card?: CardSummary) =>
  card ? `${card.brand ? card.brand[0].toUpperCase() + card.brand.slice(1) : 'Card'} •••• ${card.last4 ?? '????'}` : '';

/** "month", or "10 minutes" for a plan charged every few intervals. */
export function planInterval(plan: Plan): string {
  const unit = plan.interval ?? 'month';
  const count = plan.intervalCount ?? 1;
  return count > 1 ? `${count} ${unit}s` : unit;
}

/** "$79 / month" or "up to $40 a class" */
export function planPrice(plan: Plan): string {
  if (plan.type === 'on_demand') return `up to ${money(plan.maxPerCharge ?? 0)} a class`;
  return `${money(plan.amount ?? 0)} / ${planInterval(plan)}`;
}

export function planTerms(plan: Plan): string {
  if (plan.type === 'on_demand') {
    return `Charged after each class, never more than ${money(plan.maxPerCharge ?? 0)} at a time or ${money(plan.maxPerMonth ?? 0)} a month.`;
  }
  const first = plan.trialDays ? `First charge after a ${plan.trialDays}-day free trial` : 'First charge when you approve';
  return `${money(plan.amount ?? 0)} every ${planInterval(plan)}. ${first}.`;
}

export const PLAN_STATUS: Record<PlanStatus, string> = {
  proposing: 'Setting up',
  pending: 'Waiting for your approval',
  active: 'Active',
  suspended: 'Paused',
  cancelled: 'Cancelled',
  expired: 'Not approved in time',
};

export const CHARGE_STATUS: Record<PlanCharge['status'], string> = {
  requesting: 'Sending…',
  processing: 'Processing',
  succeeded: 'Paid',
  failed: 'Failed',
  rejected: 'Refused',
  returned: 'Returned by the bank',
};

export function fundingLabel(funding: CustomerPlan['funding']): string {
  if (!funding) return '—';
  if (funding.method === 'wallet') return 'SettleKing wallet';
  if (funding.method === 'ach') return funding.cardLast4 ? `Bank account •••• ${funding.cardLast4}` : 'Bank account';
  const brand = funding.cardBrand ? funding.cardBrand[0].toUpperCase() + funding.cardBrand.slice(1) : 'Card';
  return `${brand} •••• ${funding.cardLast4 ?? '????'}`;
}

export function when(iso?: string | null): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
}
