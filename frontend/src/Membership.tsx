import { FormEvent, useState } from 'react';

import { api, cardLabel, Member, money, SiteConfig } from './api';
import { PaymentWidget } from './Widget';

type Step =
  | { kind: 'form' }
  | { kind: 'card'; memberId: string; clientSecret: string }
  | { kind: 'confirming' }
  | { kind: 'done'; member: Member };

/**
 * "Monthly membership": the member saves a card once in a SettleKing setup widget; the studio
 * charges the membership to it each month. Nothing is charged here.
 */
export function Membership({ config }: { config: SiteConfig & { widget: NonNullable<SiteConfig['widget']> } }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'form' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const price = money(config.membership.amount);

  async function start(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { memberId, clientSecret } = await api.joinMembership({ name, email });
      setStep({ kind: 'card', memberId, clientSecret });
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /** The widget says the card is saved; the server confirms it with SettleKing before we say so. */
  async function confirm(memberId: string) {
    setStep({ kind: 'confirming' });
    const started = Date.now();
    try {
      for (;;) {
        const member = await api.syncMember(memberId);
        if (member.cardStatus === 'active') return setStep({ kind: 'done', member });
        if (member.cardStatus !== 'pending' || Date.now() - started > 30_000) break;
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      setError('We couldn’t confirm your card yet. The studio will be in touch.');
    } catch (reason) {
      setError((reason as Error).message);
    }
    setStep({ kind: 'form' });
  }

  function fail(message: string) {
    setError(message);
    setStep({ kind: 'form' });
  }

  return (
    <section id="membership" className="section">
      <div className="wrap">
        <div className="section-head">
          <span className="kicker">Card on file</span>
          <h2>Save a card, pay monthly.</h2>
          <p>
            The classic way: save your card with the studio in SettleKing’s secure form, and the studio charges the
            membership each month.
          </p>
        </div>
        <div className="panel">
          <div className="summary">
            <div>
              <strong>Monthly membership</strong>
              <span className="muted">Every class, every week. Cancel any time.</span>
            </div>
            <span className="price">{price}/mo</span>
          </div>

          {step.kind === 'form' && (
            <form className="panel-form" onSubmit={start}>
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
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button className="pill wide" type="submit" disabled={busy}>
                {busy ? 'Opening card form…' : 'Add a card'}
              </button>
              <p className="fine">
                Nothing is charged now. {config.studioName} charges {price} to this card each month.
              </p>
            </form>
          )}

          {step.kind === 'card' && (
            <>
              <PaymentWidget
                widget={config.widget}
                clientSecret={step.clientSecret}
                onSuccess={() => void confirm(step.memberId)}
                onFatal={fail}
              />
              <button type="button" className="text-button" onClick={() => setStep({ kind: 'form' })}>
                Cancel
              </button>
            </>
          )}

          {step.kind === 'confirming' && (
            <div className="inline-status" role="status">
              <div className="spinner" aria-hidden="true" />
              Confirming your card…
            </div>
          )}

          {step.kind === 'done' && (
            <div className="inline-status" role="status">
              <div className="badge ok" aria-hidden="true">
                ✓
              </div>
              <h3>You’re a member, {step.member.name.split(' ')[0]}.</h3>
              <p className="muted">
                {cardLabel(step.member.card)} is saved. We’ll charge {price} each month. Reference {step.member.reference}.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
