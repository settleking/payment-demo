import { FormEvent, useEffect, useState } from 'react';

import { api, Booking, DanceClass, money, SiteConfig } from './api';
import { Membership } from './Membership';
import { PlanResult, Plans } from './Plans';
import { PaymentWidget } from './Widget';

type PayWith = 'widget' | 'hosted';

/**
 * The whole studio on one page: pick a class, enter a name and email, then pay right here in
 * SettleKing's embedded widget ("Pay here") or on SettleKing's hosted payment page. Either way the
 * result is shown at /?booking=<id>, after the server has confirmed the payment with SettleKing.
 */
export function App() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [classes, setClasses] = useState<DanceClass[]>([]);
  const [selected, setSelected] = useState('salsa');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [payWith, setPayWith] = useState<PayWith>('widget');
  const [paying, setPaying] = useState<{ bookingId: string; clientSecret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState(() => new URLSearchParams(window.location.search).get('booking'));
  const [planReturning, setPlanReturning] = useState(() => new URLSearchParams(window.location.search).get('plan'));

  useEffect(() => {
    api.classes().then(setClasses, (reason: Error) => setError(reason.message));
    api.config().then(setConfig, () => setConfig(null));
  }, []);

  const widget = config?.widget ?? null;
  // Without a configured widget the page offers hosted checkout only.
  const method: PayWith = widget ? payWith : 'hosted';

  const chosen = classes.find((item) => item.id === selected);

  function choose(id: string) {
    setSelected(id);
    document.getElementById('book')?.scrollIntoView({ behavior: 'smooth' });
  }

  async function pay(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const started = await api.book({ classId: selected, studentName: name, email, payWith: method });
      if (started.clientSecret) {
        setPaying({ bookingId: started.bookingId, clientSecret: started.clientSecret });
        setBusy(false);
      } else if (started.checkoutUrl) {
        window.location.assign(started.checkoutUrl);
      }
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }

  /**
   * The widget reports success. That is only a signal: the result sheet asks the server, which
   * confirms the checkout with SettleKing (amount, currency, reference) before calling it paid.
   */
  function paidHere(bookingId: string) {
    setPaying(null);
    window.history.replaceState(null, '', `/?booking=${encodeURIComponent(bookingId)}`);
    setReturning(bookingId);
  }

  /** The agreement widget says the plan was approved; the result sheet confirms it with the server. */
  function planApproved(planId: string) {
    window.history.replaceState(null, '', `/?plan=${encodeURIComponent(planId)}`);
    setPlanReturning(planId);
  }

  function stopPaying(message?: string) {
    setPaying(null);
    setError(message ?? null);
  }

  return (
    <>
      <header className="nav">
        <div className="wrap nav-row">
          <a href="#top" className="logo">
            <span className="logo-mark" aria-hidden="true">
              ♪
            </span>
            Tempo
          </a>
          <nav>
            <a href="#classes" className="hide-sm">
              Classes
            </a>
            <a href="#plans" className="hide-sm">
              Plans
            </a>
            {widget && (
              <a href="#membership" className="hide-sm">
                Card on file
              </a>
            )}
            <a href="/test" className="hide-sm">
              Test guide
            </a>
            <a href="#book" className="pill small">
              Book
            </a>
          </nav>
        </div>
      </header>

      <main id="top">
        <section className="hero wrap">
          <div>
            <p className="eyebrow">Tempo Dance Studio</p>
            <h1>Dance, beautifully.</h1>
            <p className="lead">Small classes, great teachers. Drop in once, subscribe, or pay as you dance.</p>
            <div className="actions">
              <a href="#book" className="pill">
                Book a class
              </a>
              <a href="#plans" className="more">
                See plans ›
              </a>
            </div>
          </div>
          <div className="hero-card">
            <h3>Every way to pay, with SettleKing</h3>
            <ul>
              <li>One class: SettleKing checkout or pay right here</li>
              <li>Subscriptions, with a free trial or charged today</li>
              <li>Pay as you dance, within limits you approve</li>
              <li>Wallet or card, with bank top-up when your wallet is short</li>
            </ul>
            <span className="powered">
              <img src="/settleking.png" alt="" width={22} height={22} /> Payments by SettleKing
            </span>
          </div>
        </section>

        <section id="classes" className="band">
          <div className="wrap">
            <div className="section-head">
              <span className="kicker">One-time payment</span>
              <h2>Pick your class.</h2>
              <p>Pay once for a single class, on SettleKing’s checkout page or in the secure form on this page.</p>
            </div>
            <div className="grid">
              {classes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selected ? 'card selected' : 'card'}
                  aria-pressed={item.id === selected}
                  onClick={() => choose(item.id)}>
                  <span className="tag">{item.style}</span>
                  <strong>{item.title}</strong>
                  <span className="muted">{item.description}</span>
                  <span className="meta">
                    {item.schedule} · {item.instructor}
                  </span>
                  <span className="price">{money(item.amount)}</span>
                </button>
              ))}
            </div>
          </div>
        </section>

        <section id="book" className="wrap section">
          <div className="section-head">
            <h2>Book and pay.</h2>
          </div>
          <form className="panel" onSubmit={pay} hidden={Boolean(paying)}>
            {chosen && (
              <div className="summary">
                <div>
                  <strong>{chosen.title}</strong>
                  <span className="muted">{chosen.schedule}</span>
                </div>
                <span className="price">{money(chosen.amount)}</span>
              </div>
            )}
            <label>
              Name
              <input required maxLength={80} autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <label>
              Email
              <input
                required
                type="email"
                maxLength={160}
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            {widget && (
              <fieldset className="choice">
                <legend>How would you like to pay?</legend>
                <label className={method === 'widget' ? 'option selected' : 'option'}>
                  <input
                    type="radio"
                    name="payWith"
                    value="widget"
                    checked={method === 'widget'}
                    onChange={() => setPayWith('widget')}
                  />
                  <span>
                    <strong>Pay here</strong>
                    <span className="muted">Card, right on this page</span>
                  </span>
                </label>
                <label className={method === 'hosted' ? 'option selected' : 'option'}>
                  <input
                    type="radio"
                    name="payWith"
                    value="hosted"
                    checked={method === 'hosted'}
                    onChange={() => setPayWith('hosted')}
                  />
                  <span>
                    <strong>SettleKing checkout</strong>
                    <span className="muted">Card or SettleKing wallet</span>
                  </span>
                </label>
              </fieldset>
            )}
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button className="pill wide" type="submit" disabled={busy || !chosen}>
              {busy
                ? 'Opening payment…'
                : `${method === 'widget' ? 'Continue' : 'Continue to payment'}${chosen ? ` · ${money(chosen.amount)}` : ''}`}
            </button>
            <p className="fine">
              {method === 'widget'
                ? 'Your card details go straight to SettleKing in a secure form; this site never sees them.'
                : 'You’ll pay securely on SettleKing by card or wallet, then come straight back here.'}
            </p>
          </form>
          {paying && widget && (
            <div className="panel">
              {chosen && (
                <div className="summary">
                  <div>
                    <strong>{chosen.title}</strong>
                    <span className="muted">
                      {name} · {email}
                    </span>
                  </div>
                  <span className="price">{money(chosen.amount)}</span>
                </div>
              )}
              <PaymentWidget
                widget={widget}
                clientSecret={paying.clientSecret}
                onSuccess={() => paidHere(paying.bookingId)}
                onFatal={(message) => stopPaying(message)}
              />
              <button type="button" className="text-button" onClick={() => stopPaying()}>
                Cancel
              </button>
            </div>
          )}
        </section>

        {config && <Plans config={config} onApproved={planApproved} />}

        {config && widget && <Membership config={{ ...config, widget }} />}
      </main>

      <footer className="wrap footer">
        <span>
          A sample studio. Payments by SettleKing; card details never reach this server.
        </span>
        <span style={{ display: 'flex', gap: 16 }}>
          <a href="/test">Test guide</a>
          <a href="/admin">Studio admin</a>
        </span>
      </footer>

      {returning && <PaymentResult bookingId={returning} />}
      {planReturning && config && <PlanResult planId={planReturning} config={config} />}
    </>
  );
}

/** Shown when SettleKing sends the customer back: confirms the payment and reports it. */
function PaymentResult({ bookingId }: { bookingId: string }) {
  const [booking, setBooking] = useState<Booking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const started = Date.now();
    async function check(lookup: boolean) {
      try {
        const current = lookup ? await api.syncBooking(bookingId) : await api.booking(bookingId);
        if (!active) return;
        setBooking(current);
        if (current.status !== 'pending_payment') return;
        if (Date.now() - started > 60_000) return setGaveUp(true);
        // Poll; every fourth check asks the server to look the checkout up again.
        const polls = Math.round((Date.now() - started) / 3000);
        timer = window.setTimeout(() => void check(polls % 4 === 3), 3000);
      } catch (reason) {
        if (active) setError((reason as Error).message);
      }
    }
    void check(true);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [bookingId]);

  function close() {
    window.history.replaceState(null, '', '/');
    window.location.reload();
  }

  const status = error ? 'error' : booking?.status ?? 'loading';
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="result-title">
      <div className="sheet">
        {status === 'paid' && booking && (
          <>
            <div className="badge ok" aria-hidden="true">
              ✓
            </div>
            <h3 id="result-title">You’re booked.</h3>
            <p className="muted">
              {booking.title} · {money(booking.amount)} paid
              {booking.paymentMethod === 'wallet' ? ' with SettleKing wallet' : booking.paymentMethod === 'ach' ? ' by bank transfer' : ''}.
              <br />
              Reference {booking.reference}. See you on the floor, {booking.studentName.split(' ')[0]}.
            </p>
          </>
        )}
        {(status === 'loading' || status === 'pending_payment') && (
          <>
            <div className="spinner" aria-hidden="true" />
            <h3 id="result-title">Confirming your payment…</h3>
            <p className="muted" role="status">
              {gaveUp ? 'We haven’t received the payment yet.' : 'This takes a few seconds.'}
            </p>
            {gaveUp && booking?.checkoutUrl && (
              <a className="pill" href={booking.checkoutUrl}>
                Return to payment
              </a>
            )}
          </>
        )}
        {(status === 'expired' || status === 'cancelled') && (
          <>
            <div className="badge bad" aria-hidden="true">
              ×
            </div>
            <h3 id="result-title">No payment was made.</h3>
            <p className="muted">Nothing was charged. You’re welcome to book again.</p>
          </>
        )}
        {status === 'error' && (
          <>
            <h3 id="result-title">We couldn’t find that booking.</h3>
            <p className="muted">{error}</p>
          </>
        )}
        <button type="button" className="text-button" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}
