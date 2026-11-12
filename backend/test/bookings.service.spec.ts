import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BookingsService } from '../src/bookings/bookings.service';
import { AppConfig } from '../src/config';
import { MembershipsService } from '../src/memberships/memberships.service';
import { PlansService } from '../src/plans/plans.service';
import { SettleKingClient, SettleKingError } from '../src/settleking/settleking.client';
import { MerchantCheckout, WidgetSession } from '../src/settleking/settleking.types';
import { sign } from '../src/settleking/webhook-signature';
import { WebhooksService } from '../src/settleking/webhooks.service';
import { JsonStore } from '../src/storage/json-store';

const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;

describe('BookingsService', () => {
  let dir: string;
  let store: JsonStore;
  let settleking: jest.Mocked<
    Pick<SettleKingClient, 'createCheckout' | 'getCheckout' | 'checkoutPageUrl' | 'createWidgetSession' | 'getWidgetSession'>
  >;
  let bookings: BookingsService;
  let webhooks: WebhooksService;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'tds-'));
    process.env.DATA_DIR = dir;
    process.env.SETTLEKING_CLIENT_ID = 'sk_test_client';
    process.env.SETTLEKING_CLIENT_SECRET = 'sk_secret_value';
    process.env.SETTLEKING_WEBHOOK_SECRET = secret;
    process.env.PUBLIC_URL = 'https://dance.example.test';
    process.env.SETTLEKING_WIDGET_ID = widgetId;
    process.env.SETTLEKING_PUBLISHABLE_KEY = 'pk_test_abc';
    const config = new AppConfig();
    store = new JsonStore(config);
    await store.onModuleInit();
    settleking = {
      createCheckout: jest.fn().mockResolvedValue({
        id: 'chk_1',
        reference: 'TDS-1001',
        amount: { currency: 'USD', value: '25.00' },
        status: 'open',
        paymentMethods: ['card'],
      }),
      getCheckout: jest.fn(),
      checkoutPageUrl: jest.fn((id: string) => `https://pay.example.test/checkout/${id}`),
      createWidgetSession: jest.fn().mockResolvedValue(widgetSession()),
      getWidgetSession: jest.fn(),
    };
    const client = settleking as unknown as SettleKingClient;
    bookings = new BookingsService(store, client, config);
    webhooks = new WebhooksService(
      store,
      bookings,
      new MembershipsService(store, client, config),
      new PlansService(store, client, config),
      config,
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.SETTLEKING_WIDGET_ID;
    delete process.env.SETTLEKING_PUBLISHABLE_KEY;
  });

  const book = () => bookings.create({ classId: 'salsa', studentName: 'Ana Silva', email: 'Ana@Example.test' });
  const bookHere = () =>
    bookings.create({ classId: 'salsa', studentName: 'Ana Silva', email: 'Ana@Example.test', payWith: 'widget' });
  const booked = () => store.bookings()[0];
  const salsa = { currency: 'USD', value: '25.00' };

  function delivery(data: Record<string, unknown>, id = 'msg_1', type = 'MERCHANT_PAYMENT_RECEIVED') {
    const raw = Buffer.from(JSON.stringify({ id: 'evt', type, data: { reference: 'TDS-1001', ...data } }));
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

  it('opens an idempotent checkout that returns to the page', async () => {
    const { checkoutUrl } = await book();

    expect(checkoutUrl).toBe('https://pay.example.test/checkout/chk_1');
    expect(settleking.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: booked().reference,
        amount: { currency: 'USD', value: '25.00' },
        returnUrl: `https://dance.example.test/?booking=${booked().id}`,
      }),
      booked().id,
    );
  });

  it('marks the booking paid from a signed webhook, once', async () => {
    await book();
    const paid = delivery({ checkoutSessionId: 'chk_1', amount: { currency: 'USD', value: '25.00' }, paymentMethod: 'card' });

    await expect(webhooks.receive(paid.raw, paid.headers)).resolves.toEqual({ outcome: 'applied' });
    await expect(webhooks.receive(paid.raw, paid.headers)).resolves.toEqual({ outcome: 'duplicate' });
    expect(booked()).toMatchObject({ status: 'paid', paymentMethod: 'card', confirmedBy: 'webhook' });
  });

  it('ignores a payment whose amount does not match', async () => {
    await book();
    const wrong = delivery({ checkoutSessionId: 'chk_1', amount: { currency: 'USD', value: '1.00' } });

    await webhooks.receive(wrong.raw, wrong.headers);

    expect(booked().status).toBe('pending_payment');
  });

  it('ignores a payment in another currency', async () => {
    await book();
    const wrong = delivery({ checkoutSessionId: 'chk_1', amount: { currency: 'EUR', value: '25.00' } });

    await webhooks.receive(wrong.raw, wrong.headers);

    expect(booked().status).toBe('pending_payment');
  });

  it('rejects unsigned webhooks', async () => {
    const forged = delivery({ checkoutSessionId: 'chk_1', amount: { currency: 'USD', value: '25.00' } });
    forged.headers['webhook-signature'] = 'v1,AAAA';

    await expect(webhooks.receive(forged.raw, forged.headers)).rejects.toThrow('Invalid webhook signature');
  });

  it('confirms the payment by lookup when the customer returns', async () => {
    await book();
    settleking.getCheckout.mockResolvedValue({
      id: 'chk_1',
      reference: 'TDS-1001',
      status: 'paid',
      amount: { currency: 'USD', value: '25.00' },
      paidAt: '2026-09-27T09:05:00.000Z',
    } as MerchantCheckout);

    expect((await bookings.sync(booked().id)).status).toBe('paid');
    expect(booked().confirmedBy).toBe('lookup');
  });

  it('closes the booking when its checkout expires unpaid', async () => {
    await book();
    settleking.getCheckout.mockResolvedValue({ id: 'chk_1', status: 'expired', amount: { currency: 'USD', value: '25.00' } } as MerchantCheckout);

    expect((await bookings.sync(booked().id)).status).toBe('expired');
  });

  it('cancels the booking when SettleKing is unreachable', async () => {
    settleking.createCheckout.mockRejectedValueOnce(new Error('down'));

    await expect(book()).rejects.toThrow('We could not open the payment page');
    expect(booked().status).toBe('cancelled');
  });

  it('ignores a payment for another reference', async () => {
    await book();
    const wrong = delivery({ checkoutSessionId: 'chk_1', reference: 'TDS-9999', amount: salsa });

    await webhooks.receive(wrong.raw, wrong.headers);

    expect(booked().status).toBe('pending_payment');
  });

  it('acknowledges event types it does not use', async () => {
    const other = delivery({ customerId: 'cus_1' }, 'msg_9', 'MERCHANT_SOMETHING_NEW');

    await expect(webhooks.receive(other.raw, other.headers)).resolves.toEqual({ outcome: 'ignored' });
  });

  describe('Pay here (widget)', () => {
    it('opens a payment widget session for the booking and returns only its client secret', async () => {
      const result = await bookHere();

      expect(result).toEqual({ bookingId: booked().id, clientSecret: 'wss_secret' });
      expect(settleking.createWidgetSession).toHaveBeenCalledWith(
        {
          widgetId,
          mode: 'payment',
          amount: salsa,
          reference: 'TDS-1001',
          description: 'Salsa Foundations for Ana Silva',
          customer: { reference: 'ana@example.test', email: 'ana@example.test', name: 'Ana Silva' },
          savePaymentMethod: 'optional',
        },
        `${booked().id}-widget`,
      );
      expect(settleking.createCheckout).not.toHaveBeenCalled();
      expect(booked()).toMatchObject({
        channel: 'widget',
        widgetSessionId: 'ws_1',
        checkoutSessionId: 'chk_w1',
        customerId: 'cus_1',
        status: 'pending_payment',
      });
    });

    it('falls back to no card saving when the studio lacks the capability', async () => {
      settleking.createWidgetSession.mockRejectedValueOnce(
        new SettleKingError('Not enabled', 403, 'CAPABILITY_NOT_ENABLED'),
      );

      await bookHere();

      expect(settleking.createWidgetSession).toHaveBeenCalledTimes(2);
      expect(settleking.createWidgetSession.mock.calls[1][0].savePaymentMethod).toBe('off');
      expect(settleking.createWidgetSession.mock.calls[1][1]).toBe(`${booked().id}-widget`);

      // Later bookings skip the refused attempt for a while.
      await bookHere();
      expect(settleking.createWidgetSession).toHaveBeenCalledTimes(3);
      expect(settleking.createWidgetSession.mock.calls[2][0].savePaymentMethod).toBe('off');
    });

    it('cancels the booking on other SettleKing errors', async () => {
      settleking.createWidgetSession.mockRejectedValueOnce(new SettleKingError('Widget disabled', 409, 'WIDGET_DISABLED'));

      await expect(bookHere()).rejects.toThrow('We could not open the payment form');
      expect(settleking.createWidgetSession).toHaveBeenCalledTimes(1);
      expect(booked().status).toBe('cancelled');
    });

    it('refuses "Pay here" when no widget is configured', async () => {
      delete process.env.SETTLEKING_WIDGET_ID;
      const plain = new BookingsService(store, settleking as unknown as SettleKingClient, new AppConfig());

      await expect(
        plain.create({ classId: 'salsa', studentName: 'Ana', email: 'ana@example.test', payWith: 'widget' }),
      ).rejects.toThrow('Paying on this page is not available');
    });

    it('marks it paid only after SettleKing confirms the checkout server-side', async () => {
      await bookHere();
      settleking.getCheckout.mockResolvedValue({
        id: 'chk_w1',
        reference: 'TDS-1001',
        status: 'paid',
        amount: salsa,
      } as MerchantCheckout);

      expect((await bookings.sync(booked().id)).status).toBe('paid');
      expect(settleking.getCheckout).toHaveBeenCalledWith('chk_w1');
      expect(booked().confirmedBy).toBe('lookup');
    });

    it('does not trust a lookup whose amount or reference differ', async () => {
      await bookHere();
      settleking.getCheckout.mockResolvedValue({
        id: 'chk_w1',
        reference: 'TDS-1001',
        status: 'paid',
        amount: { currency: 'USD', value: '0.50' },
      } as MerchantCheckout);
      await bookings.sync(booked().id);
      settleking.getCheckout.mockResolvedValue({ id: 'chk_w1', reference: 'OTHER', status: 'paid', amount: salsa } as MerchantCheckout);
      await bookings.sync(booked().id);

      expect(booked().status).toBe('pending_payment');
    });

    it('marks it paid from the signed webhook, matched by checkout id', async () => {
      await bookHere();
      const paid = delivery({ checkoutSessionId: 'chk_w1', amount: salsa, paymentMethod: 'card', origin: 'widget' });

      await expect(webhooks.receive(paid.raw, paid.headers)).resolves.toEqual({ outcome: 'applied' });
      expect(booked()).toMatchObject({ status: 'paid', confirmedBy: 'webhook' });
    });

    it('expires the booking when its widget session expires unpaid', async () => {
      await bookHere();
      settleking.getCheckout.mockResolvedValue({ id: 'chk_w1', reference: 'TDS-1001', status: 'open', amount: salsa } as MerchantCheckout);
      settleking.getWidgetSession.mockResolvedValue(widgetSession({ status: 'expired', clientSecret: null }));

      expect((await bookings.sync(booked().id)).status).toBe('expired');
    });
  });
});

const widgetId = '6f1b2a7e-3c55-4d1e-9b9a-2f0f5c1d7e01';

function widgetSession(overrides: Partial<WidgetSession> = {}): WidgetSession {
  return {
    id: 'ws_1',
    widgetId,
    mode: 'payment',
    status: 'open',
    clientSecret: 'wss_secret',
    expiresAt: null,
    amount: { currency: 'USD', value: '25.00' },
    reference: 'TDS-1001',
    checkoutSessionId: 'chk_w1',
    customerId: 'cus_1',
    savePaymentMethod: 'optional',
    paymentMethods: ['card'],
    paymentMethodId: null,
    failureCode: null,
    createdAt: null,
    completedAt: null,
    ...overrides,
  };
}
