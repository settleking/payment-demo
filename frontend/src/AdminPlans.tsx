import { useEffect, useRef, useState } from 'react';

import {
  AdminBooking,
  AdminPlan,
  adminApi,
  CHARGE_STATUS,
  DanceClass,
  fundingLabel,
  money,
  PLAN_STATUS,
  SiteConfig,
  when,
} from './api';

/**
 * Admin › Plans: every customer plan (SettleKing payment agreement) with its charges. Pay As You
 * Dance plans are charged here, one class at a time; any plan can be cancelled or re-read from
 * SettleKing.
 */
export function AdminPlans({ token, config, classes }: { token: string; config: SiteConfig | null; classes: DanceClass[] }) {
  const [plans, setPlans] = useState<AdminPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<string | null>(null);
  const timers = useRef<number[]>([]);

  useEffect(() => {
    void load();
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, [token]);

  async function load() {
    try {
      setPlans(await adminApi(token).plans());
      setError(null);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  function replace(plan: AdminPlan) {
    setPlans((current) => current?.map((candidate) => (candidate.id === plan.id ? plan : candidate)) ?? null);
  }

  /** Re-reads the plan from SettleKing every 2 s while a charge is still open (up to a minute). */
  function follow(id: string, started = Date.now()) {
    if (Date.now() - started > 60_000) return;
    const timer = window.setTimeout(async () => {
      try {
        const plan = await adminApi(token).syncPlan(id);
        replace(plan);
        if (plan.charges.some((charge) => charge.status === 'processing' || charge.status === 'requesting')) {
          follow(id, started);
        }
      } catch {
        // The next manual refresh shows it.
      }
    }, 2000);
    timers.current.push(timer);
  }

  async function act(plan: AdminPlan, action: 'sync' | 'charge' | 'cancel') {
    setBusy(plan.id);
    setError(null);
    try {
      const api = adminApi(token);
      const updated =
        action === 'sync'
          ? await api.syncPlan(plan.id)
          : action === 'cancel'
            ? await api.cancelPlan(plan.id)
            : await api.chargePlan(plan.id, picked[plan.id] ?? classes[0]?.id ?? '');
      replace(updated);
      if (action === 'charge') follow(plan.id);
      setConfirming(null);
    } catch (reason) {
      setError((reason as Error).message);
      void load();
    } finally {
      setBusy(null);
    }
  }

  const title = (planId: string) => config?.plans.find((plan) => plan.id === planId)?.title ?? planId;

  return (
    <>
      <div className="member-actions" style={{ justifyContent: 'center', marginBottom: 16 }}>
        <button type="button" className="pill ghost small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="error center" role="alert">
          {error}
        </p>
      )}
      {plans && plans.length === 0 && <p className="muted center">No plans yet.</p>}
      <ul className="members">
        {plans?.map((plan) => (
          <li key={plan.id} className="member" data-plan={plan.reference}>
            <div className="member-head">
              <div>
                <strong>
                  {title(plan.planId)} · {plan.name}
                </strong>
                <span className="muted">
                  {plan.email} · {plan.reference} · approved via {plan.approvedVia === 'widget' ? 'widget' : 'SettleKing page'}
                </span>
              </div>
              <span className={`chip ${plan.status}`}>{PLAN_STATUS[plan.status]}</span>
            </div>
            <dl className="facts">
              <div>
                <dt>Paying with</dt>
                <dd>{fundingLabel(plan.funding)}</dd>
              </div>
              {plan.type === 'recurring' ? (
                <div>
                  <dt>Next charge</dt>
                  <dd>{plan.status === 'active' ? when(plan.nextChargeAt) : '—'}</dd>
                </div>
              ) : (
                <div>
                  <dt>Charged this month</dt>
                  <dd>{money(plan.chargedThisMonth ?? 0)}</dd>
                </div>
              )}
              <div>
                <dt>Agreement</dt>
                <dd>{plan.agreementId ? `${plan.agreementId.slice(0, 8)}…` : '—'}</dd>
              </div>
              <div>
                <dt>Ended</dt>
                <dd>{plan.endedBy ? `by ${plan.endedBy}${plan.endReason ? ` (${plan.endReason})` : ''}` : '—'}</dd>
              </div>
            </dl>
            {plan.charges.length > 0 && (
              <ul className="charges" aria-label={`Charges for ${plan.reference}`}>
                {plan.charges.slice(0, 6).map((charge, index) => (
                  <li key={charge.id ?? `pending-${index}`}>
                    <span>
                      {when(charge.createdAt)} · {money(charge.amount)}
                      {charge.description ? ` · ${charge.description}` : charge.cycle ? ` · cycle ${charge.cycle}` : ''}
                      {charge.viaDeposit ? ' · topped up from bank' : ''}
                    </span>
                    <span className={`chip ${charge.status}`}>
                      {CHARGE_STATUS[charge.status]}
                      {charge.failureCode ? ` · ${charge.failureCode}` : ''}
                    </span>
                    {charge.failureMessage && <span className="why">{charge.failureMessage}</span>}
                  </li>
                ))}
              </ul>
            )}
            <div className="member-actions">
              {plan.type === 'on_demand' && plan.status === 'active' && (
                <>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="muted">Class</span>
                    <select
                      value={picked[plan.id] ?? classes[0]?.id ?? ''}
                      onChange={(event) => setPicked({ ...picked, [plan.id]: event.target.value })}>
                      {classes.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title} · {money(item.amount)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="pill small"
                    disabled={busy === plan.id}
                    onClick={() => void act(plan, 'charge')}>
                    Charge for class
                  </button>
                </>
              )}
              <button type="button" className="pill ghost small" disabled={busy === plan.id} onClick={() => void act(plan, 'sync')}>
                Read from SettleKing
              </button>
              {(plan.status === 'active' || plan.status === 'suspended' || plan.status === 'pending') &&
                (confirming === plan.id ? (
                  <>
                    <button
                      type="button"
                      className="pill danger small"
                      disabled={busy === plan.id}
                      onClick={() => void act(plan, 'cancel')}>
                      Yes, cancel plan
                    </button>
                    <button type="button" className="text-button" onClick={() => setConfirming(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="text-button" onClick={() => setConfirming(plan.id)}>
                    Cancel plan
                  </button>
                ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

const BOOKING_STATUS: Record<AdminBooking['status'], string> = {
  pending_payment: 'Waiting for payment',
  paid: 'Paid',
  payment_reversed: 'Reversed',
  expired: 'Expired',
  cancelled: 'Cancelled',
};

const BOOKING_CHIP: Record<AdminBooking['status'], string> = {
  pending_payment: 'pending',
  paid: 'paid',
  payment_reversed: 'reversed',
  expired: 'failed',
  cancelled: 'failed',
};

/** Admin › Bookings: one-time class payments (hosted checkout and Pay here). */
export function AdminBookings({ token }: { token: string }) {
  const [bookings, setBookings] = useState<AdminBooking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setBookings(await adminApi(token).bookings());
      setError(null);
    } catch (reason) {
      setError((reason as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [token]);

  return (
    <>
      <div className="member-actions" style={{ justifyContent: 'center', marginBottom: 16 }}>
        <button type="button" className="pill ghost small" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {error && (
        <p className="error center" role="alert">
          {error}
        </p>
      )}
      {bookings && bookings.length === 0 && <p className="muted center">No bookings yet.</p>}
      {bookings && bookings.length > 0 && (
        <div className="table-wrap" style={{ maxWidth: 820, margin: '0 auto' }}>
          <table>
            <thead>
              <tr>
                <th>Booking</th>
                <th>Class</th>
                <th>Paid with</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {bookings.map((booking) => (
                <tr key={booking.id} data-booking={booking.reference}>
                  <td>
                    <strong>{booking.reference}</strong>
                    <div className="muted">
                      {booking.studentName} · {when(booking.createdAt)}
                    </div>
                  </td>
                  <td>
                    {booking.title}
                    <div className="muted">{money(booking.amount)}</div>
                  </td>
                  <td>
                    {booking.channel === 'widget' ? 'Pay here' : 'SettleKing checkout'}
                    <div className="muted">
                      {booking.paymentMethod ?? '—'}
                      {booking.confirmedBy ? ` · confirmed by ${booking.confirmedBy}` : ''}
                    </div>
                  </td>
                  <td>
                    <span className={`chip ${BOOKING_CHIP[booking.status]}`}>{BOOKING_STATUS[booking.status]}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
