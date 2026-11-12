import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BookingsService } from '../src/bookings/bookings.service';
import { AppConfig } from '../src/config';
import { MembershipsService } from '../src/memberships/memberships.service';
import { PlansService } from '../src/plans/plans.service';
import { SettleKingClient, SettleKingError } from '../src/settleking/settleking.client';
import { Agreement, AgreementCharge } from '../src/settleking/settleking.types';
import { sign } from '../src/settleking/webhook-signature';
import { WebhooksService } from '../src/settleking/webhooks.service';
import { JsonStore } from '../src/storage/json-store';

const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const widgetId = '6f1b2a7e-3c55-4d1e-9b9a-2f0f5c1d7e01';
const agreementId = '0b6c1d2e-3f40-4a5b-8c6d-7e8f9a0b1c2d';

type Client = Pick<
  SettleKingClient,
  'createAgreement' | 'getAgreement' | 'agreementCharges' | 'chargeAgreement' | 'cancelAgreement' | 'createWidgetSession'
>;

describe('PlansService', () => {
  let dir: string;
  let store: JsonStore;
  let settleking: jest.Mocked<Client>;
  let plans: PlansService;
  let config: AppConfig;
  let webhooks: WebhooksService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tds-'));
    process.env.DATA_DIR = dir;
    process.env.SETTLEKING_CLIENT_ID = 'sk_test_client';
    process.env.SETTLEKING_CLIENT_SECRET = 'sk_secret_value';
    process.env.SETTLEKING_WEBHOOK_SECRET = secret;
    process.env.SETTLEKING_WIDGET_ID = widgetId;
    process.env.SETTLEKING_PUBLISHABLE_KEY = 'pk_test_abc';
    process.env.PUBLIC_URL = 'https://dance.example.test';
    config = new AppConfig();
    store = new JsonStore(config);
    await store.onModuleInit();
    settleking = {
      createAgreement: jest.fn((request, _key: string) => Promise.resolve(agreement({ reference: request.reference, type: request.type }))),
      getAgreement: jest.fn(),
      agreementCharges: jest.fn().mockResolvedValue([]),
      chargeAgreement: jest.fn(),
      cancelAgreement: jest.fn(),
      createWidgetSession: jest.fn().mockResolvedValue({
        id: 'ws_1',
        widgetId,
        mode: 'agreement',
        status: 'open',
        clientSecret: 'wss_secret',
      }),
    };
    const client = settleking as unknown as SettleKingClient;
    plans = new PlansService(store, client, config);
    webhooks = new WebhooksService(
      store,
      new BookingsService(store, client, config),
      new MembershipsService(store, client, config),
      plans,
      config,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SETTLEKING_WIDGET_ID;
    delete process.env.SETTLEKING_PUBLISHABLE_KEY;
    delete process.env.PUBLIC_URL;
  });

  const plan = () => store.plans()[0];

  function agreement(overrides: Partial<Agreement> = {}): Agreement {
    return {
      id: agreementId,
      status: 'pending',
      type: 'recurring',
      reference: 'TDS-P1001',
      paymentMethods: ['wallet', 'card'],
      approvalUrl: `https://pay.example.test/agreements/${agreementId}`,
      ...overrides,
    };
  }

  function charge(overrides: Partial<AgreementCharge> = {}): AgreementCharge {
    return {
      id: 'chg_1',
      agreementId,
      status: 'processing',
      amount: { currency: 'USD', value: '25.00' },
      attempt: 1,
      viaDeposit: false,
      initiatedBy: 'merchant_api',
      reference: 'TDS-P1001-C1',
      checkoutSessionId: 'cs_1',
      createdAt: '2026-11-10T12:00:00.000Z',
      ...overrides,
    };
  }

  function delivery(type: string, data: Record<string, unknown>, id = `msg_${Math.random()}`) {
    const raw = Buffer.from(JSON.stringify({ id: 'evt', type, data }));
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      raw,
      headers: {
        'webhook-id': id,
        'webhook-timestamp': String(timestamp),
        'webhook-signature': `v1,${sign(secret, id, timestamp, raw).toString('base64')}`,
      },
    };
  }

  async function activeFlex() {
    await plans.start({ planId: 'flex', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });
    settleking.getAgreement.mockResolvedValue(
      agreement({ type: 'on_demand', status: 'active', funding: { method: 'wallet' } }),
    );
    await plans.sync(plan().id);
  }

  it('proposes a subscription with a trial and sends the customer to SettleKing to approve it', async () => {
    const before = Date.now();
    const started = await plans.start({ planId: 'unlimited', name: 'Ada', email: 'Ada@Example.test', approveVia: 'hosted' });

    expect(started.approvalUrl).toBe(`https://pay.example.test/agreements/${agreementId}`);
    const [request, key] = settleking.createAgreement.mock.calls[0];
    expect(key).toBe(`${plan().id}-agreement`);
    expect(request).toMatchObject({
      type: 'recurring',
      reference: 'TDS-P1001',
      amount: { currency: 'USD', value: '79.00' },
      interval: 'month',
      intervalCount: 1,
      paymentMethods: ['wallet', 'card'],
      returnUrl: `https://dance.example.test/?plan=${plan().id}`,
      payerEmail: 'ada@example.test',
    });
    // A week's free trial: the first charge is seven days out.
    const firstCharge = Date.parse(request.firstChargeAt!);
    expect(firstCharge - before).toBeGreaterThanOrEqual(7 * 24 * 3600_000 - 1000);
    expect(plan()).toMatchObject({ status: 'pending', agreementId, email: 'ada@example.test' });
  });

  it('does not offer the minute test plan unless it is switched on', async () => {
    await expect(
      plans.start({ planId: 'minutes', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' }),
    ).rejects.toThrow('Choose a plan');
    expect(settleking.createAgreement).not.toHaveBeenCalled();
  });

  it('proposes the test plan every PLAN_TEST_MINUTES minutes when it is switched on', async () => {
    Object.assign(config, { planTestMinutes: 10 });

    await plans.start({ planId: 'minutes', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });

    const [request] = settleking.createAgreement.mock.calls[0];
    expect(request).toMatchObject({
      type: 'recurring',
      amount: { currency: 'USD', value: '1.00' },
      interval: 'minute',
      intervalCount: 10,
    });
    expect(request.firstChargeAt).toBeUndefined();
  });

  it('proposes pay-as-you-dance with per-charge and monthly limits only', async () => {
    await plans.start({ planId: 'flex', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });

    const [request] = settleking.createAgreement.mock.calls[0];
    expect(request).toMatchObject({
      type: 'on_demand',
      maxAmountPerCharge: { currency: 'USD', value: '40.00' },
      maxAmountPerMonth: { currency: 'USD', value: '160.00' },
    });
    expect(request.amount).toBeUndefined();
    expect(request.interval).toBeUndefined();
  });

  it('opens an agreement widget session for approval on the studio page', async () => {
    const started = await plans.start({ planId: 'weekly', name: 'Ada', email: 'ada@example.test', approveVia: 'widget' });

    expect(started.clientSecret).toBe('wss_secret');
    expect(settleking.createWidgetSession).toHaveBeenCalledWith(
      { widgetId, mode: 'agreement', agreementId },
      `${plan().id}-widget`,
    );
    expect(plan().widgetSessionId).toBe('ws_1');
  });

  it('falls back to the approval link when the widget session cannot be opened', async () => {
    settleking.createWidgetSession.mockRejectedValue(new SettleKingError('down', 503));

    const started = await plans.start({ planId: 'weekly', name: 'Ada', email: 'ada@example.test', approveVia: 'widget' });

    expect(started).toEqual({ planId: plan().id, approvalUrl: `https://pay.example.test/agreements/${agreementId}` });
  });

  it('follows the agreement when SettleKing says it changed', async () => {
    await plans.start({ planId: 'weekly', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });
    settleking.getAgreement.mockResolvedValue(
      agreement({
        status: 'active',
        funding: { method: 'card', cardBrand: 'visa', cardLast4: '1111' },
        nextChargeAt: '2026-11-17T12:00:00.000Z',
        chargedThisMonth: { currency: 'USD', value: '15.00' },
      }),
    );
    settleking.agreementCharges.mockResolvedValue([
      charge({ status: 'succeeded', amount: { currency: 'USD', value: '15.00' }, initiatedBy: 'schedule', cycle: 1 }),
    ]);

    const { raw, headers } = delivery('MERCHANT_AGREEMENT_UPDATED', { agreementId, status: 'active' });
    await expect(webhooks.receive(raw, headers)).resolves.toEqual({ outcome: 'applied' });

    expect(plan()).toMatchObject({
      status: 'active',
      funding: { method: 'card', cardLast4: '1111' },
      nextChargeAt: '2026-11-17T12:00:00.000Z',
      chargedThisMonth: 1500,
    });
    expect(plan().charges[0]).toMatchObject({ status: 'succeeded', amount: 1500, cycle: 1 });
  });

  it('ignores an agreement whose reference is not the plan’s', async () => {
    await plans.start({ planId: 'weekly', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });
    settleking.getAgreement.mockResolvedValue(agreement({ status: 'active', reference: 'SOMEONE-ELSE' }));

    await plans.sync(plan().id);

    expect(plan().status).toBe('pending');
  });

  it('matches a scheduled charge’s payment webhook to its plan by checkout id', async () => {
    await plans.start({ planId: 'weekly', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });
    settleking.getAgreement.mockResolvedValue(agreement({ status: 'active' }));
    await plans.sync(plan().id);
    settleking.agreementCharges.mockResolvedValue([charge({ status: 'succeeded', checkoutSessionId: 'cs_9' })]);

    const { raw, headers } = delivery('MERCHANT_PAYMENT_RECEIVED', {
      checkoutSessionId: 'cs_9',
      reference: 'TDS-P1001-1',
      amount: { currency: 'USD', value: '15.00' },
      origin: 'agreement',
    });
    await expect(webhooks.receive(raw, headers)).resolves.toEqual({ outcome: 'applied' });

    expect(plan().charges[0]).toMatchObject({ status: 'succeeded', checkoutSessionId: 'cs_9' });
  });

  it('charges pay-as-you-dance for a class, recording the request first', async () => {
    await activeFlex();
    settleking.chargeAgreement.mockResolvedValue(charge());

    await plans.charge(plan().id, { classId: 'salsa' });

    expect(settleking.chargeAgreement).toHaveBeenCalledWith(
      agreementId,
      { amount: { currency: 'USD', value: '25.00' }, reference: 'TDS-P1001-C1', description: 'Salsa Foundations, Mondays · 7 pm' },
      `${plan().id}-charge-1`,
    );
    expect(plan().charges[0]).toMatchObject({ id: 'chg_1', status: 'processing', amount: 2500 });
  });

  it('keeps a rejected charge with SettleKing’s reason', async () => {
    await activeFlex();
    settleking.chargeAgreement.mockResolvedValue(
      charge({ status: 'rejected', failureCode: 'OVER_PAYER_MONTHLY_LIMIT', checkoutSessionId: null }),
    );

    await plans.charge(plan().id, { classId: 'salsa' });

    expect(plan().charges[0]).toMatchObject({ status: 'rejected', failureCode: 'OVER_PAYER_MONTHLY_LIMIT' });
  });

  it('resends the same Idempotency-Key when SettleKing’s answer was lost', async () => {
    await activeFlex();
    settleking.chargeAgreement.mockRejectedValueOnce(new SettleKingError('timeout', 0, 'UNREACHABLE'));

    await expect(plans.charge(plan().id, { classId: 'salsa' })).rejects.toThrow('retry cannot charge twice');
    expect(plan().charges[0].status).toBe('requesting');

    settleking.chargeAgreement.mockResolvedValue(charge());
    await plans.charge(plan().id, { classId: 'hiphop' });

    const keys = settleking.chargeAgreement.mock.calls.map((call) => call[2]);
    expect(keys).toEqual([`${plan().id}-charge-1`, `${plan().id}-charge-1`]);
    // The retry is the same request (same amount), not the newly picked class.
    expect(settleking.chargeAgreement.mock.calls[1][1].amount).toEqual({ currency: 'USD', value: '25.00' });
    expect(plan().charges).toHaveLength(1);
  });

  it('refuses to charge a subscription or a plan that is not active', async () => {
    await plans.start({ planId: 'weekly', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });
    await expect(plans.charge(plan().id, { classId: 'salsa' })).rejects.toThrow('Only pay-as-you-dance');

    await plans.start({ planId: 'flex', name: 'Ada', email: 'ada@example.test', approveVia: 'hosted' });
    await expect(plans.charge(store.plans()[0].id, { classId: 'salsa' })).rejects.toThrow('not active');
    expect(settleking.chargeAgreement).not.toHaveBeenCalled();
  });

  it('cancels the agreement at SettleKing when the customer stops the plan', async () => {
    await activeFlex();
    settleking.cancelAgreement.mockResolvedValue(
      agreement({ type: 'on_demand', status: 'cancelled', endedBy: 'merchant', endReason: 'customer_cancelled_at_studio' }),
    );

    await expect(plans.cancelByCustomer(plan().id, 'eve@example.test')).rejects.toThrow('not the email');
    const view = await plans.cancelByCustomer(plan().id, 'Ada@Example.test');

    expect(settleking.cancelAgreement).toHaveBeenCalledWith(agreementId, 'customer_cancelled_at_studio', `${plan().id}-cancel`);
    expect(view.status).toBe('cancelled');
  });
});
