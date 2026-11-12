import { useEffect, useState } from 'react';

import { api, SiteConfig } from './api';

interface Scenario {
  id: string;
  kind: string;
  title: string;
  where: string;
  steps: string[];
  expect: string[];
}

/**
 * /test: every payment scenario the studio supports, with the steps to run it end to end and what
 * should happen at the studio and in SettleKing. Written for testers; links point at this
 * environment's SettleKing.
 */
export function Guide() {
  const [config, setConfig] = useState<SiteConfig | null>(null);
  useEffect(() => {
    api.config().then(setConfig, () => setConfig(null));
  }, []);
  const app = config?.appUrl ?? 'https://app.stage.settleking.com';

  const scenarios: Scenario[] = [
    {
      id: 'one-time-hosted',
      kind: 'One-time',
      title: 'Book a class on SettleKing checkout',
      where: 'Home › Book and pay › SettleKing checkout',
      steps: [
        'Pick a class, enter a name and email, choose SettleKing checkout and continue.',
        'On SettleKing: Proceed to pay, sign in, pick wallet, card or bank account and pay.',
      ],
      expect: [
        'You come back to the studio and see “You’re booked.”',
        'Admin › Bookings shows it paid; the studio got MERCHANT_PAYMENT_RECEIVED.',
      ],
    },
    {
      id: 'one-time-widget',
      kind: 'One-time',
      title: 'Pay here, in the widget',
      where: 'Home › Book and pay › Pay here',
      steps: [
        'Choose Pay here and continue.',
        'Pay with a test card inside the form on this page (no sign-in needed).',
        'Optional: tick “Save this card”, press Email me a code and enter the code sent to the booking email before paying.',
      ],
      expect: [
        '“You’re booked.” appears without leaving the page.',
        'Card details never reach the studio.',
        'A card is saved only after the emailed code is confirmed.',
      ],
    },
    {
      id: 'subscription-trial-hosted',
      kind: 'Subscription',
      title: 'Unlimited Monthly with a 7-day free trial, approved on SettleKing',
      where: 'Home › Plans › Unlimited Monthly › On SettleKing',
      steps: [
        'Enter a name and email, choose On SettleKing and continue.',
        'On SettleKing: sign in, choose wallet or card, tick “I agree”, enter the emailed code.',
      ],
      expect: [
        'Back at the studio: “You’re in”, status Active, next charge in 7 days, no charge yet.',
        'SettleKing charges $79 automatically when the trial ends, then every month.',
      ],
    },
    {
      id: 'subscription-weekly-widget',
      kind: 'Subscription',
      title: 'Weekly Practice, approved from this page',
      where: 'Home › Plans › Weekly Practice › Right here',
      steps: [
        'Choose Right here and continue: the SettleKing form appears on the page.',
        'Press Approve with SettleKing; approve in the window that opens.',
      ],
      expect: [
        'The window closes and the studio shows Active with the first $15 charge (Processing, then Paid).',
        'The next charge is a week after the first one.',
      ],
    },
    {
      id: 'on-demand',
      kind: 'Charge when needed',
      title: 'Pay As You Dance: the studio charges after each class',
      where: 'Home › Plans › Pay As You Dance, then Admin › Plans',
      steps: [
        'Approve the plan (either way).',
        'In Admin › Plans, pick the class attended and press Charge.',
        'Charge again with a different class each time if the plan pays by card (the card sandbox refuses repeats of the same amount).',
      ],
      expect: [
        'Each charge appears as Processing, then Paid, on the admin page and on the customer’s plan.',
        'Past $160 in a month, or above a limit the customer set, the charge is Refused with the reason; no money moves.',
      ],
    },
    {
      id: 'top-up',
      kind: 'Wallet top-up',
      title: 'Wallet short, topped up from the bank',
      where: 'Any plan paid by wallet',
      steps: [
        'When approving, choose the SettleKing wallet and tick “If my balance is short, top up from my bank and pay”.',
        'Charge more than the wallet holds (Pay As You Dance makes this easy).',
      ],
      expect: [
        'The charge stays Processing while the bank deposit arrives (1–2 business days in the sandbox unless simulated), then Paid with “topped up from bank”.',
        'Without top-up ticked, the same charge is Refused (INSUFFICIENT_BALANCE).',
      ],
    },
    {
      id: 'limits',
      kind: 'Customer limits',
      title: 'The customer’s own limits',
      where: `SettleKing › Account settings › Payment limits`,
      steps: ['Set a per-charge or monthly limit in SettleKing.', 'Charge a Pay As You Dance plan above it.'],
      expect: ['The charge is Refused (OVER_PAYER_…); approving a subscription above the per-charge limit is blocked.'],
    },
    {
      id: 'cancel',
      kind: 'Cancel',
      title: 'Cancel from the studio or from SettleKing',
      where: 'Plan sheet › Cancel plan, or SettleKing › Subscriptions & authorisations',
      steps: ['Cancel the plan in either place.'],
      expect: [
        'Both sides show Cancelled; the studio learns it from MERCHANT_AGREEMENT_UPDATED.',
        'The studio can no longer charge it (AGREEMENT_NOT_ACTIVE).',
      ],
    },
    {
      id: 'paused',
      kind: 'Paused',
      title: 'A failed subscription charge pauses the plan',
      where: 'A subscription whose charge fails (e.g. wallet short, no top-up)',
      steps: ['Let a charge fail.', 'Resume it in SettleKing › Subscriptions & authorisations.'],
      expect: [
        'Tried once only: the plan shows Paused with the reason; nothing else is charged.',
        'Resume tries once more right away.',
      ],
    },
    {
      id: 'card-on-file',
      kind: 'Card on file',
      title: 'Save a card, the studio charges monthly',
      where: 'Home › Card on file, then Admin › Members',
      steps: [
        'Tick the authorisation, press Email me a code and enter the code sent to your email.',
        'Save a card in the form.',
        'In Admin › Members press Charge $49 now.',
      ],
      expect: [
        'The member shows the saved card; the charge goes Processing, then Paid.',
        'Needs SettleKing to have enabled merchant-initiated payments for the studio.',
      ],
    },
  ];

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
            <a href="/">Studio</a>
            <a href="/admin">Admin</a>
          </nav>
        </div>
      </header>
      <main className="wrap section">
        <div className="section-head">
          <span className="kicker">For testers</span>
          <h2>Test every way to pay.</h2>
          <p>
            Each scenario below runs end to end against this environment’s SettleKing. Sign in on SettleKing with a
            personal test account; the studio admin page needs the admin token.
          </p>
        </div>

        <div className="guide">
          <details open>
            <summary>Test data</summary>
            <ul>
              <li>
                Cards: <code>4111 1111 1111 1111</code> (Visa) or <code>5431 1111 1111 1111</code> (Mastercard), expiry{' '}
                <code>10/29</code>, CVV <code>999</code>. Amounts under $1.00 are declined.
              </li>
              <li>
                The card sandbox refuses the same card and amount repeated within a short window: vary the amount (pick
                a different class) between tries.
              </li>
              <li>
                Bank account (ACH in the widget): routing <code>490000018</code>, account <code>24413815</code>.
              </li>
              <li>
                Payments and approvals ask for a 6-digit code emailed to the SettleKing account. Saving a card or bank
                account without signing in asks for a code sent to the email you give. On dev the codes are in Mailpit.
              </li>
              <li>
                More: <a href={`${app}/developers/docs/test-data`}>SettleKing sandbox test data</a> ·{' '}
                <a href={`${app}/developers/docs/agreements`}>Subscriptions and charges when needed</a>
              </li>
            </ul>
          </details>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Scenario</th>
                  <th>Where</th>
                </tr>
              </thead>
              <tbody>
                {scenarios.map((scenario) => (
                  <tr key={scenario.id}>
                    <td>
                      <span className="tag">{scenario.kind}</span>
                    </td>
                    <td>
                      <a href={`#${scenario.id}`}>{scenario.title}</a>
                    </td>
                    <td className="muted">{scenario.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {scenarios.map((scenario) => (
            <details key={scenario.id} id={scenario.id}>
              <summary>
                {scenario.kind}: {scenario.title}
              </summary>
              <p className="muted" style={{ margin: '8px 0 0' }}>
                {scenario.where}
              </p>
              <ol>
                {scenario.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ol>
              <ul>
                {scenario.expect.map((line) => (
                  <li key={line}>
                    <strong>Expect:</strong> {line}
                  </li>
                ))}
              </ul>
            </details>
          ))}
        </div>
      </main>
    </>
  );
}
