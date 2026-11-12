import { FormEvent, useEffect, useRef, useState } from 'react';

import { AdminMember, adminApi, api, cardLabel, DanceClass, MemberCharge, money, SiteConfig } from './api';
import { AdminBookings, AdminPlans } from './AdminPlans';

type Tab = 'plans' | 'bookings' | 'members';

const TOKEN_KEY = 'tds-admin-token';

function storedToken(): string {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * /admin: the studio's staff page. Lists members, charges this month's membership to a saved card
 * (a merchant-initiated SettleKing payment) and removes cards. Every call carries ADMIN_TOKEN.
 */
export function Admin() {
  const [token, setToken] = useState(storedToken);
  const [members, setMembers] = useState<AdminMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [amount, setAmount] = useState<number | null>(null);
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [classes, setClasses] = useState<DanceClass[]>([]);
  const [tab, setTab] = useState<Tab>('plans');
  const timers = useRef<number[]>([]);

  useEffect(() => {
    api.config().then(
      (loaded) => {
        setConfig(loaded);
        setAmount(loaded.membership.amount);
      },
      () => undefined,
    );
    api.classes().then(setClasses, () => undefined);
    // Opens straight away with the token remembered for this tab.
    if (token) void load(token);
    const pending = timers.current;
    return () => pending.forEach((timer) => window.clearTimeout(timer));
  }, []);

  async function load(value: string) {
    setError(null);
    try {
      const loaded = await adminApi(value).members();
      setMembers(loaded);
      for (const member of loaded) {
        if (member.lastCharge) watch(member.id, member.lastCharge, Date.now(), value);
      }
      try {
        window.sessionStorage.setItem(TOKEN_KEY, value);
      } catch {
        // Not remembered; the page still works.
      }
    } catch (reason) {
      setMembers(null);
      setError((reason as Error).message);
    }
  }

  function signIn(event: FormEvent) {
    event.preventDefault();
    void load(token);
  }

  function replace(member: AdminMember) {
    setMembers((current) => current?.map((candidate) => (candidate.id === member.id ? member : candidate)) ?? null);
  }

  /** Polls the charge (the server reads GET /payments/{id}) until SettleKing reports an outcome. */
  function watch(memberId: string, charge: MemberCharge, started = Date.now(), auth = token) {
    if (!isOpen(charge) || Date.now() - started > 60_000) return;
    const timer = window.setTimeout(async () => {
      try {
        const member = await adminApi(auth).refreshCharge(memberId, charge.id);
        replace(member);
        const current = member.charges.find((candidate) => candidate.id === charge.id);
        if (current) watch(memberId, current, started, auth);
      } catch (reason) {
        setError((reason as Error).message);
      }
    }, 2000);
    timers.current.push(timer);
  }

  async function charge(member: AdminMember) {
    setBusy(member.id);
    setError(null);
    try {
      const updated = await adminApi(token).charge(member.id);
      replace(updated);
      if (updated.lastCharge) watch(member.id, updated.lastCharge);
    } catch (reason) {
      setError((reason as Error).message);
      void load(token);
    } finally {
      setBusy(null);
    }
  }

  async function removeCard(member: AdminMember) {
    if (!window.confirm(`Remove ${member.name}'s card? It can't be charged again.`)) return;
    setBusy(member.id);
    setError(null);
    try {
      replace(await adminApi(token).removeCard(member.id));
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <header className="nav">
        <div className="wrap nav-row">
          <a href="/" className="logo">
            <span className="logo-mark" aria-hidden="true">
              ♪
            </span>
            Tempo
          </a>
          <nav>
            <span className="muted">Studio admin</span>
            <a href="/test">Test guide</a>
          </nav>
        </div>
      </header>
      <main className="wrap admin">
        <h2 className="center">Studio admin.</h2>
        <form className="token-row" onSubmit={signIn}>
          <label>
            Admin token
            <input
              type="password"
              autoComplete="off"
              required
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </label>
          <button className="pill" type="submit">
            {members ? 'Refresh' : 'Open'}
          </button>
        </form>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {members && (
          <div className="tabs-row">
            <div className="tabs" role="tablist" aria-label="Admin sections">
              {(['plans', 'bookings', 'members'] as Tab[]).map((name) => (
                <button key={name} type="button" role="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
                  {name === 'plans' ? 'Plans' : name === 'bookings' ? 'Bookings' : 'Card on file'}
                </button>
              ))}
            </div>
          </div>
        )}
        {members && tab === 'plans' && <AdminPlans token={token} config={config} classes={classes} />}
        {members && tab === 'bookings' && <AdminBookings token={token} />}
        {tab === 'members' && (
          <>
        {members && members.length === 0 && <p className="muted center">No members yet.</p>}
        {members && members.length > 0 && (
          <ul className="members">
            {members.map((member) => (
              <li key={member.id} className="member">
                <div className="member-head">
                  <div>
                    <strong>{member.name}</strong>
                    <span className="muted">
                      {member.email} · {member.reference}
                    </span>
                  </div>
                  <span className={`chip ${member.cardStatus}`}>{cardText(member)}</span>
                </div>
                {member.lastCharge && <ChargeLine charge={member.lastCharge} />}
                <div className="member-actions">
                  <button
                    type="button"
                    className="pill small"
                    disabled={member.cardStatus !== 'active' || busy === member.id || isOpen(member.lastCharge)}
                    onClick={() => void charge(member)}>
                    Charge {amount === null ? '' : `${money(amount)} `}now
                  </button>
                  <button
                    type="button"
                    className="text-button"
                    disabled={member.cardStatus !== 'active' || busy === member.id}
                    onClick={() => void removeCard(member)}>
                    Remove card
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
          </>
        )}
      </main>
    </>
  );
}

function ChargeLine({ charge }: { charge: MemberCharge }) {
  const label: Record<MemberCharge['status'], string> = {
    requesting: 'No answer from SettleKing yet; charge again to retry safely',
    processing: 'Processing…',
    paid: 'Paid',
    failed: `Failed${charge.failureCode ? ` (${charge.failureCode})` : ''}`,
    reversed: 'Reversed by the bank',
  };
  return (
    <p className={`charge ${charge.status}`} role="status">
      {charge.period} · {money(charge.amount)} · {label[charge.status]}
      {charge.attempt > 1 ? ` · attempt ${charge.attempt}` : ''}
    </p>
  );
}

function cardText(member: AdminMember): string {
  switch (member.cardStatus) {
    case 'active':
      return cardLabel(member.card);
    case 'pending':
      return 'Adding a card…';
    case 'removed':
      return 'Card removed';
    default:
      return 'No card';
  }
}

function isOpen(charge?: MemberCharge): boolean {
  return charge?.status === 'processing' || (charge?.status === 'requesting' && Boolean(charge.paymentId));
}
