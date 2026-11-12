import { FormEvent, useEffect, useState } from 'react';

import {
  api,
  CHARGE_STATUS,
  CustomerPlan,
  fundingLabel,
  money,
  Plan,
  PLAN_STATUS,
  planInterval,
  planPrice,
  planTerms,
  SiteConfig,
  when,
} from './api';
import { PaymentWidget } from './Widget';

type ApproveVia = 'widget' | 'hosted';

/**
 * Plans: each is a SettleKing payment agreement. The studio proposes the terms; the customer
 * approves them once on SettleKing, either from this page (the agreement widget opens SettleKing in
 * a popup) or on SettleKing's own page. SettleKing then makes every charge.
 */
export function Plans({ config, onApproved }: { config: SiteConfig; onApproved: (planId: string) => void }) {
  const [selected, setSelected] = useState(config.plans[0]?.id ?? '');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [via, setVia] = useState<ApproveVia>(config.widget ? 'widget' : 'hosted');
  const [approving, setApproving] = useState<{ planId: string; clientSecret: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = config.plans.find((candidate) => candidate.id === selected);
  const method: ApproveVia = config.widget ? via : 'hosted';

  function choose(id: string) {
    setSelected(id);
    setApproving(null);
    document.getElementById('plan-form')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function start(event: FormEvent) {
    event.preventDefault();
    if (!plan) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.startPlan({ planId: plan.id, name, email, approveVia: method });
      if (started.clientSecret) {
        setApproving({ planId: started.planId, clientSecret: started.clientSecret });
        setBusy(false);
      } else if (started.approvalUrl) {
        window.location.assign(started.approvalUrl);
      }
    } catch (reason) {
      setError((reason as Error).message);
      setBusy(false);
    }
  }

  return (
    <section id="plans" className="band">
      <div className="wrap">
        <div className="section-head">
          <span className="kicker">Subscriptions &amp; pay as you go</span>
          <h2>Approve once. Dance all season.</h2>
          <p>
            Approve a plan once with SettleKing and pay by SettleKing wallet, card or bank account. You see every charge, set your own
            limits and can cancel at any time in your SettleKing account.
          </p>
        </div>

        <div className="grid three">
          {config.plans.map((item) => (
            <PlanCard key={item.id} plan={item} selected={item.id === selected} onChoose={() => choose(item.id)} />
          ))}
        </div>

        <div id="plan-form" style={{ marginTop: 32 }}>
          {plan && !approving && (
            <form className="panel" onSubmit={start}>
              <div className="summary">
                <div>
                  <strong>{plan.title}</strong>
                  <span className="muted">{planTerms(plan)}</span>
                </div>
                <span className="price">{planPrice(plan)}</span>
              </div>
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
              {config.widget && (
                <fieldset className="choice">
                  <legend>Where would you like to approve it?</legend>
                  <label className={method === 'widget' ? 'option selected' : 'option'}>
                    <input type="radio" name="approveVia" checked={method === 'widget'} onChange={() => setVia('widget')} />
                    <span>
                      <strong>Right here</strong>
                      <span className="muted">SettleKing opens in a small window</span>
                    </span>
                  </label>
                  <label className={method === 'hosted' ? 'option selected' : 'option'}>
                    <input type="radio" name="approveVia" checked={method === 'hosted'} onChange={() => setVia('hosted')} />
                    <span>
                      <strong>On SettleKing</strong>
                      <span className="muted">Go to SettleKing, then come back</span>
                    </span>
                  </label>
                </fieldset>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="pill wide" type="submit" disabled={busy}>
                {busy ? 'Setting up…' : 'Continue to approve with SettleKing'}
              </button>
              <p className="fine">
                Nothing is charged until you approve. You choose your wallet, a card or a bank account on SettleKing and confirm with a
                code.
              </p>
            </form>
          )}

          {approving && config.widget && plan && (
            <div className="panel">
              <div className="summary">
                <div>
                  <strong>{plan.title}</strong>
                  <span className="muted">
                    {name} · {email}
                  </span>
                </div>
                <span className="price">{planPrice(plan)}</span>
              </div>
              <PaymentWidget
                widget={config.widget}
                clientSecret={approving.clientSecret}
                onSuccess={() => {
                  const id = approving.planId;
                  setApproving(null);
                  onApproved(id);
                }}
                onFatal={(message) => {
                  setApproving(null);
                  setError(message);
                }}
              />
              <button type="button" className="text-button" onClick={() => setApproving(null)}>
                Cancel
              </button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function PlanCard({ plan, selected, onChoose }: { plan: Plan; selected: boolean; onChoose: () => void }) {
  return (
    <button type="button" className={selected ? 'card selected' : 'card'} aria-pressed={selected} onClick={onChoose}>
      <span className={plan.type === 'on_demand' ? 'tag warm' : 'tag'}>
        {plan.type === 'on_demand' ? 'Charge when needed' : 'Subscription'}
      </span>
      <strong>{plan.title}</strong>
      <span className="muted">{plan.tagline}</span>
      <ul className="perks">
        {plan.perks.map((perk) => (
          <li key={perk}>{perk}</li>
        ))}
      </ul>
      <span className="price">
        {plan.type === 'on_demand' ? (
          <>
            {money(plan.maxPerCharge ?? 0)} <small>max a class</small>
          </>
        ) : (
          <>
            {money(plan.amount ?? 0)} <small>/ {planInterval(plan)}</small>
          </>
        )}
      </span>
    </button>
  );
}

/**
 * Shown at /?plan=<id>, when SettleKing sends the customer back or the widget reports approval.
 * The server reads the agreement from SettleKing; the browser's word is never taken for it.
 */
export function PlanResult({ planId, config }: { planId: string; config: SiteConfig }) {
  const [plan, setPlan] = useState<CustomerPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelEmail, setCancelEmail] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    const started = Date.now();
    async function check() {
      try {
        const current = await api.syncPlan(planId);
        if (!active) return;
        setPlan(current);
        // A subscription charged on approval takes its first charge a few seconds after approving:
        // keep watching until that charge shows up and settles.
        const firstChargeDue =
          current.type === 'recurring' &&
          current.status === 'active' &&
          current.charges.length === 0 &&
          Boolean(current.nextChargeAt) &&
          Date.parse(current.nextChargeAt!) <= Date.now() + 60_000;
        const waiting =
          current.status === 'proposing' ||
          current.status === 'pending' ||
          firstChargeDue ||
          current.charges.some((charge) => charge.status === 'processing' || charge.status === 'requesting');
        if (!waiting) return;
        if (Date.now() - started > 90_000) return setGaveUp(true);
        timer = window.setTimeout(() => void check(), 3000);
      } catch (reason) {
        if (active) setError((reason as Error).message);
      }
    }
    void check();
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [planId]);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      setPlan(await api.cancelPlan(planId, cancelEmail));
      setConfirmCancel(false);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function close() {
    window.history.replaceState(null, '', '/');
    window.location.reload();
  }

  const catalog = plan ? config.plans.find((candidate) => candidate.id === plan.planId) : undefined;
  const status = plan?.status;
  return (
    <div className="sheet-backdrop" role="dialog" aria-modal="true" aria-labelledby="plan-title">
      <div className="sheet wide">
        <div className="sheet-top">
          {!plan && !error && <div className="spinner" aria-hidden="true" />}
          {status === 'active' && (
            <div className="badge ok" aria-hidden="true">
              ✓
            </div>
          )}
          {(status === 'pending' || status === 'proposing') && <div className="spinner" aria-hidden="true" />}
          {status === 'suspended' && (
            <div className="badge wait" aria-hidden="true">
              !
            </div>
          )}
          {(status === 'cancelled' || status === 'expired') && (
            <div className="badge bad" aria-hidden="true">
              ×
            </div>
          )}
          <h3 id="plan-title">
            {!plan && (error ? 'We couldn’t find that plan.' : 'Checking with SettleKing…')}
            {status === 'active' && `You’re in, ${plan!.name.split(' ')[0]}.`}
            {(status === 'pending' || status === 'proposing') && 'Waiting for your approval…'}
            {status === 'suspended' && 'Your plan is paused.'}
            {status === 'cancelled' && 'Your plan is cancelled.'}
            {status === 'expired' && 'The plan was not approved in time.'}
          </h3>
          {catalog && <p className="muted">{planTerms(catalog)}</p>}
          {status === 'suspended' && (
            <p className="notice">
              A charge didn’t go through, so SettleKing paused the plan after one try. Resume it in your SettleKing
              account to try once more.
            </p>
          )}
          {gaveUp && (status === 'pending' || status === 'proposing') && plan?.approvalUrl && (
            <a className="pill" href={plan.approvalUrl}>
              Approve on SettleKing
            </a>
          )}
        </div>

        {plan && (
          <dl className="facts">
            <div>
              <dt>Plan</dt>
              <dd>{catalog?.title ?? plan.planId}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>
                <span className={`chip ${plan.status}`}>{PLAN_STATUS[plan.status]}</span>
              </dd>
            </div>
            <div>
              <dt>Paying with</dt>
              <dd>{fundingLabel(plan.funding)}</dd>
            </div>
            {plan.type === 'recurring' && (
              <div>
                <dt>Next charge</dt>
                <dd>{plan.status === 'active' ? when(plan.nextChargeAt) : '—'}</dd>
              </div>
            )}
            {plan.type === 'on_demand' && (
              <div>
                <dt>Charged this month</dt>
                <dd>{money(plan.chargedThisMonth ?? 0)}</dd>
              </div>
            )}
            <div>
              <dt>Reference</dt>
              <dd>{plan.reference}</dd>
            </div>
          </dl>
        )}

        {plan && plan.charges.length > 0 && (
          <ul className="charges" aria-label="Charges">
            {plan.charges.map((charge, index) => (
              <li key={charge.id ?? `pending-${index}`}>
                <span>
                  {when(charge.createdAt)} · {money(charge.amount)}
                  {charge.viaDeposit ? ' · topped up from bank' : ''}
                </span>
                <span className={`chip ${charge.status}`}>{CHARGE_STATUS[charge.status]}</span>
                {charge.failureMessage && <span className="why">{charge.failureMessage}</span>}
              </li>
            ))}
          </ul>
        )}

        {error && plan && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {error && !plan && <p className="muted center">{error}</p>}

        {plan && (plan.status === 'active' || plan.status === 'suspended' || plan.status === 'pending') && (
          <div className="member-actions" style={{ justifyContent: 'center' }}>
            {!confirmCancel ? (
              <>
                <a className="pill ghost small" href={`${config.appUrl}/payment/agreements`} target="_blank" rel="noreferrer">
                  Manage in SettleKing
                </a>
                <button type="button" className="pill danger small" onClick={() => setConfirmCancel(true)}>
                  Cancel plan
                </button>
              </>
            ) : (
              <>
                <label style={{ minWidth: 220 }}>
                  Your email, to confirm
                  <input
                    type="email"
                    autoComplete="email"
                    value={cancelEmail}
                    onChange={(e) => setCancelEmail(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  className="pill danger small"
                  disabled={busy || !cancelEmail.includes('@')}
                  onClick={() => void cancel()}>
                  {busy ? 'Cancelling…' : 'Yes, cancel'}
                </button>
                <button type="button" className="text-button" onClick={() => setConfirmCancel(false)}>
                  Keep it
                </button>
              </>
            )}
          </div>
        )}

        <button type="button" className="text-button" onClick={close}>
          Done
        </button>
      </div>
    </div>
  );
}
