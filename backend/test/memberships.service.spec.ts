import { ExecutionContext } from '@nestjs/common';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BookingsService } from '../src/bookings/bookings.service';
import { AppConfig } from '../src/config';
import { AdminGuard } from '../src/memberships/admin.guard';
import { MembershipsService } from '../src/memberships/memberships.service';
import { PlansService } from '../src/plans/plans.service';
import { SettleKingClient, SettleKingError } from '../src/settleking/settleking.client';
import { MerchantPayment, WidgetSession } from '../src/settleking/settleking.types';
import { sign } from '../src/settleking/webhook-signature';
import { WebhooksService } from '../src/settleking/webhooks.service';
import { JsonStore } from '../src/storage/json-store';

const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const widgetId = '6f1b2a7e-3c55-4d1e-9b9a-2f0f5c1d7e01';
const membership = { currency: 'USD', value: '49.00' };

type Client = Pick<
  SettleKingClient,
  | 'createWidgetSession'
  | 'getWidgetSession'
  | 'customerPaymentMethods'
  | 'createPayment'
  | 'getPayment'
  | 'detachPaymentMethod'
>;

describe('MembershipsService', () => {
  let dir: string;
  let store: JsonStore;
  let settleking: jest.Mocked<Client>;
  let memberships: MembershipsService;
  let webhooks: WebhooksService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tds-'));
    process.env.DATA_DIR = dir;
    process.env.SETTLEKING_CLIENT_ID = 'sk_test_client';
    process.env.SETTLEKING_CLIENT_SECRET = 'sk_secret_value';
    process.env.SETTLEKING_WEBHOOK_SECRET = secret;
    process.env.SETTLEKING_WIDGET_ID = widgetId;
    process.env.SETTLEKING_PUBLISHABLE_KEY = 'pk_test_abc';
    const config = new AppConfig();
    store = new JsonStore(config);
    await store.onModuleInit();
    settleking = {
      createWidgetSession: jest.fn().mockResolvedValue(setupSession()),
      getWidgetSession: jest.fn(),
      customerPaymentMethods: jest.fn().mockResolvedValue([
        { id: 'pm_1', customerId: 'cus_1', type: 'card', brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, status: 'active' },
      ]),
      createPayment: jest.fn(),
      getPayment: jest.fn(),
      detachPaymentMethod: jest.fn().mockResolvedValue({ id: 'pm_1', customerId: 'cus_1', type: 'card', status: 'detached' }),
    };
    const client = settleking as unknown as SettleKingClient;
    memberships = new MembershipsService(store, client, config);
    webhooks = new WebhooksService(
      store,
      new BookingsService(store, client, config),
      memberships,
      new PlansService(store, client, config),
      config,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SETTLEKING_WIDGET_ID;
    delete process.env.SETTLEKING_PUBLISHABLE_KEY;
    delete process.env.ADMIN_TOKEN;
  });

  const join_ = () => memberships.join({ name: 'Ada Lovelace', email: 'Ada@Example.test' });
  const member = () => store.members()[0];

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

  /** A member whose card was saved (by the setup lookup). */
  async function withCard() {
    await join_();
    settleking.getWidgetSession.mockResolvedValue(
      setupSession({ status: 'succeeded', clientSecret: null, paymentMethodId: 'pm_1' }),
    );
    await memberships.sync(member().id);
  }

  it('opens a setup widget session for the customer by reference', async () => {
    const result = await join_();

    expect(result).toEqual({ memberId: member().id, clientSecret: 'wss_setup' });
    expect(settleking.createWidgetSession).toHaveBeenCalledWith(
      expect.objectContaining({
        widgetId,
        mode: 'setup',
        customer: { reference: 'ada@example.test', email: 'ada@example.test', name: 'Ada Lovelace' },
        paymentMethods: ['card'],
      }),
      `${member().id}-setup-1`,
    );
    expect(settleking.createWidgetSession.mock.calls[0][0]).not.toHaveProperty('amount');
    expect(member()).toMatchObject({ cardStatus: 'pending', customerId: 'cus_1', setupSessionId: 'ws_setup_1' });
  });

  it('explains when saving cards is not enabled for the studio', async () => {
    settleking.createWidgetSession.mockRejectedValueOnce(new SettleKingError('No', 403, 'CAPABILITY_NOT_ENABLED'));

    await expect(join_()).rejects.toThrow('not enabled for this studio');
    expect(store.members()).toHaveLength(0);
  });

  it('learns the saved card from the setup session, not from the browser', async () => {
    await withCard();

    expect(settleking.getWidgetSession).toHaveBeenCalledWith('ws_setup_1');
    expect(settleking.customerPaymentMethods).toHaveBeenCalledWith('cus_1');
    expect(member()).toMatchObject({
      cardStatus: 'active',
      card: { paymentMethodId: 'pm_1', brand: 'visa', last4: '4242', learnedFrom: 'lookup' },
    });
  });

  it('keeps the member pending while the setup session is still open', async () => {
    await join_();
    settleking.getWidgetSession.mockResolvedValue(setupSession());

    expect((await memberships.sync(member().id)).cardStatus).toBe('pending');
  });

  it('learns the saved card from the MERCHANT_PAYMENT_METHOD_SAVED webhook', async () => {
    await join_();
    const saved = delivery('MERCHANT_PAYMENT_METHOD_SAVED', {
      customerId: 'cus_1',
      customerReference: 'ada@example.test',
      paymentMethodId: 'pm_1',
      type: 'card',
      brand: 'mastercard',
      last4: '4444',
      expMonth: 1,
      expYear: 2031,
      widgetSessionId: 'ws_setup_1',
      savedAt: '2026-10-05T10:00:00Z',
    });

    await expect(webhooks.receive(saved.raw, saved.headers)).resolves.toEqual({ outcome: 'applied' });
    expect(member()).toMatchObject({
      cardStatus: 'active',
      card: { paymentMethodId: 'pm_1', brand: 'mastercard', last4: '4444', learnedFrom: 'webhook' },
    });
  });

  it('ignores a saved card of another customer', async () => {
    await join_();
    const saved = delivery('MERCHANT_PAYMENT_METHOD_SAVED', {
      customerId: 'cus_other',
      paymentMethodId: 'pm_9',
      widgetSessionId: 'ws_setup_1',
    });

    await webhooks.receive(saved.raw, saved.headers);

    expect(member().cardStatus).toBe('pending');
  });

  it('charges the membership with an idempotency key per member, month and attempt', async () => {
    await withCard();
    settleking.createPayment.mockResolvedValue(payment({ status: 'processing' }));

    const view = await memberships.charge(member().id);

    const period = new Date().toISOString().slice(0, 7);
    expect(settleking.createPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        paymentMethodId: 'pm_1',
        amount: membership,
        reference: `${member().reference}-${period}-1`,
      }),
      `${member().id}-${period}-1`,
    );
    expect(view.lastCharge).toMatchObject({ status: 'processing', paymentId: 'pay_1', attempt: 1 });
    await expect(memberships.charge(member().id)).rejects.toThrow('already charged');
  });

  it('polls the payment and records the outcome', async () => {
    await withCard();
    settleking.createPayment.mockResolvedValue(payment({ status: 'processing' }));
    await memberships.charge(member().id);
    settleking.getPayment.mockResolvedValue(payment({ status: 'paid', paidAt: '2026-10-05T10:01:00.000Z' }));

    const view = await memberships.refreshCharge(member().id, member().charges[0].id);

    expect(settleking.getPayment).toHaveBeenCalledWith('pay_1');
    expect(view.lastCharge).toMatchObject({ status: 'paid', confirmedBy: 'lookup' });
  });

  it('resends the same key when SettleKing did not answer', async () => {
    await withCard();
    settleking.createPayment.mockRejectedValueOnce(new SettleKingError('SettleKing could not be reached', 0, 'UNREACHABLE'));

    await expect(memberships.charge(member().id)).rejects.toThrow('cannot charge twice');
    expect(member().charges[0].status).toBe('requesting');

    settleking.createPayment.mockResolvedValue(payment({ status: 'processing' }));
    await memberships.charge(member().id);

    const keys = settleking.createPayment.mock.calls.map((call) => call[1]);
    expect(keys[0]).toBe(keys[1]);
    expect(member().charges).toHaveLength(1);
  });

  it('records MERCHANT_PAYMENT_FAILED and lets the next attempt use a new key', async () => {
    await withCard();
    settleking.createPayment.mockResolvedValue(payment({ status: 'processing' }));
    await memberships.charge(member().id);
    const { reference } = member().charges[0];
    const failed = delivery('MERCHANT_PAYMENT_FAILED', {
      checkoutSessionId: 'pay_1',
      reference,
      amount: membership,
      failureCode: 'CARD_DECLINED',
      failedAt: '2026-10-05T10:01:00Z',
      origin: 'merchant_initiated',
    });

    await expect(webhooks.receive(failed.raw, failed.headers)).resolves.toEqual({ outcome: 'applied' });
    expect(member().charges[0]).toMatchObject({ status: 'failed', failureCode: 'CARD_DECLINED' });

    settleking.createPayment.mockResolvedValue(payment({ id: 'pay_2', status: 'processing', reference: reference.replace(/-1$/, '-2') }));
    await memberships.charge(member().id);
    expect(settleking.createPayment.mock.calls[1][1]).toMatch(/-2$/);
    expect(member().charges[0]).toMatchObject({ attempt: 2, status: 'processing' });
  });

  it('records MERCHANT_PAYMENT_RECEIVED, even before the payment id was stored', async () => {
    await withCard();
    settleking.createPayment.mockRejectedValueOnce(new SettleKingError('timeout', 0, 'UNREACHABLE'));
    await expect(memberships.charge(member().id)).rejects.toThrow();
    const { reference } = member().charges[0];
    const paid = delivery('MERCHANT_PAYMENT_RECEIVED', {
      checkoutSessionId: 'pay_1',
      reference,
      amount: membership,
      paymentMethod: 'card',
      paidAt: '2026-10-05T10:01:00Z',
      origin: 'merchant_initiated',
    });

    await expect(webhooks.receive(paid.raw, paid.headers)).resolves.toEqual({ outcome: 'applied' });
    expect(member().charges[0]).toMatchObject({ status: 'paid', paymentId: 'pay_1', confirmedBy: 'webhook' });
  });

  it('ignores a received payment whose amount differs', async () => {
    await withCard();
    settleking.createPayment.mockResolvedValue(payment({ status: 'processing' }));
    await memberships.charge(member().id);
    const paid = delivery('MERCHANT_PAYMENT_RECEIVED', {
      checkoutSessionId: 'pay_1',
      reference: member().charges[0].reference,
      amount: { currency: 'USD', value: '1.00' },
    });

    await webhooks.receive(paid.raw, paid.headers);

    expect(member().charges[0].status).toBe('processing');
  });

  it('records a refused charge and reports the missing capability', async () => {
    await withCard();
    settleking.createPayment.mockRejectedValueOnce(new SettleKingError('No', 403, 'CAPABILITY_NOT_ENABLED'));

    await expect(memberships.charge(member().id)).rejects.toThrow('not enabled for this studio');
    expect(member().charges[0]).toMatchObject({ status: 'failed', failureCode: 'CAPABILITY_NOT_ENABLED' });
  });

  it('removes the saved card at SettleKing', async () => {
    await withCard();

    await memberships.removeCard(member().id);

    expect(settleking.detachPaymentMethod).toHaveBeenCalledWith('cus_1', 'pm_1');
    expect(member().cardStatus).toBe('removed');
    await expect(memberships.charge(member().id)).rejects.toThrow('no saved card');
  });

  describe('AdminGuard', () => {
    const context = (token?: string) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ header: () => token }) }),
      }) as unknown as ExecutionContext;

    it('is off without ADMIN_TOKEN', () => {
      expect(() => new AdminGuard(new AppConfig()).canActivate(context('anything'))).toThrow('turned off');
    });

    it('needs the exact token', () => {
      process.env.ADMIN_TOKEN = 'studio-admin-token';
      const guard = new AdminGuard(new AppConfig());

      expect(() => guard.canActivate(context())).toThrow('Wrong admin token');
      expect(() => guard.canActivate(context('studio-admin-tokeN'))).toThrow('Wrong admin token');
      expect(guard.canActivate(context('studio-admin-token'))).toBe(true);
    });
  });
});

function setupSession(overrides: Partial<WidgetSession> = {}): WidgetSession {
  return {
    id: 'ws_setup_1',
    widgetId,
    mode: 'setup',
    status: 'open',
    clientSecret: 'wss_setup',
    expiresAt: null,
    amount: null,
    reference: null,
    checkoutSessionId: null,
    customerId: 'cus_1',
    savePaymentMethod: null,
    paymentMethods: ['card'],
    paymentMethodId: null,
    failureCode: null,
    createdAt: null,
    completedAt: null,
    ...overrides,
  };
}

function payment(overrides: Partial<MerchantPayment>): MerchantPayment {
  const period = new Date().toISOString().slice(0, 7);
  return {
    id: 'pay_1',
    reference: `TDS-M1001-${period}-1`,
    amount: membership,
    status: 'processing',
    paymentMethods: ['card'],
    createdAt: '2026-10-05T10:00:00.000Z',
    expiresAt: '2026-10-05T11:00:00.000Z',
    origin: 'merchant_initiated',
    ...overrides,
  };
}
