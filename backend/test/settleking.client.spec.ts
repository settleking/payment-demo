import { AppConfig } from '../src/config';
import { isCapabilityMissing, SettleKingClient, SettleKingError } from '../src/settleking/settleking.client';

const base = 'https://api.example.test/api/v1/payments/merchant/integrations';

describe('SettleKingClient', () => {
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;
  let client: SettleKingClient;

  beforeEach(() => {
    process.env.SETTLEKING_API_URL = 'https://api.example.test/';
    process.env.SETTLEKING_CLIENT_ID = 'sk_test_client';
    process.env.SETTLEKING_CLIENT_SECRET = 'sk_secret_value';
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    client = new SettleKingClient(new AppConfig());
  });

  afterEach(() => {
    delete process.env.SETTLEKING_API_URL;
    global.fetch = realFetch;
  });

  function answer(status: number, body: unknown) {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }

  function sent(index = 0) {
    const [url, init] = fetchMock.mock.calls[index] as [string, RequestInit];
    return { url, init, headers: init.headers as Record<string, string>, body: init.body ? JSON.parse(String(init.body)) : undefined };
  }

  it('creates a widget session with Basic auth and an Idempotency-Key', async () => {
    answer(201, {
      message: 'Widget session created',
      response: { id: 'ws_1', status: 'open', clientSecret: 'wss_x', expiresAt: 1791235074.097, createdAt: 1791233274, completedAt: null },
    });

    const session = await client.createWidgetSession(
      { widgetId: 'w', mode: 'payment', amount: { currency: 'USD', value: '25.00' }, reference: 'TDS-1001' },
      'booking-1-widget',
    );

    const request = sent();
    expect(request.url).toBe(`${base}/widget-sessions`);
    expect(request.init.method).toBe('POST');
    expect(request.headers['Idempotency-Key']).toBe('booking-1-widget');
    expect(request.headers.Authorization).toBe(`Basic ${Buffer.from('sk_test_client:sk_secret_value').toString('base64')}`);
    expect(request.body).toMatchObject({ mode: 'payment', reference: 'TDS-1001' });
    expect(session).toMatchObject({ id: 'ws_1', clientSecret: 'wss_x', expiresAt: '2026-10-05T21:17:54.097Z', completedAt: null });
  });

  it('reads widget sessions, payments and saved cards', async () => {
    answer(200, { response: { id: 'ws_1', status: 'succeeded', paymentMethodId: 'pm_1' } });
    answer(200, { response: { id: 'pay_1', status: 'paid', createdAt: 1791233274, expiresAt: 1791236874, paidAt: 1791233300 } });
    answer(200, { response: [{ id: 'pm_1', status: 'active', last4: '4242' }] });

    await expect(client.getWidgetSession('ws_1')).resolves.toMatchObject({ paymentMethodId: 'pm_1' });
    await expect(client.getPayment('pay_1')).resolves.toMatchObject({ status: 'paid', paidAt: '2026-10-05T20:48:20.000Z' });
    await expect(client.customerPaymentMethods('cus 1')).resolves.toEqual([{ id: 'pm_1', status: 'active', last4: '4242' }]);

    expect(fetchMock.mock.calls.map((call) => [call[1].method, call[0]])).toEqual([
      ['GET', `${base}/widget-sessions/ws_1`],
      ['GET', `${base}/payments/pay_1`],
      ['GET', `${base}/customers/cus%201/payment-methods`],
    ]);
  });

  it('charges a saved card with an Idempotency-Key', async () => {
    answer(202, { message: 'Payment accepted', response: { id: 'pay_1', status: 'processing', createdAt: 1791233274, expiresAt: 1791236874 } });

    const payment = await client.createPayment(
      { customerId: 'cus_1', paymentMethodId: 'pm_1', amount: { currency: 'USD', value: '49.00' }, reference: 'TDS-M1-2026-10-1' },
      'member-2026-10-1',
    );

    expect(payment.status).toBe('processing');
    expect(sent().url).toBe(`${base}/payments`);
    expect(sent().headers['Idempotency-Key']).toBe('member-2026-10-1');
  });

  it('removes a saved card with DELETE', async () => {
    answer(200, { response: { id: 'pm_1', status: 'detached' } });

    await expect(client.detachPaymentMethod('cus_1', 'pm_1')).resolves.toMatchObject({ status: 'detached' });
    expect(sent().init.method).toBe('DELETE');
    expect(sent().url).toBe(`${base}/customers/cus_1/payment-methods/pm_1`);
    expect(sent().body).toBeUndefined();
  });

  it('turns error answers into SettleKingError with the error code', async () => {
    answer(403, { message: 'Merchant-initiated payments are not enabled', errorCode: 'CAPABILITY_NOT_ENABLED' });

    const error = await client.createPayment(
      { customerId: 'c', paymentMethodId: 'p', amount: { currency: 'USD', value: '1.00' }, reference: 'r' },
      'k',
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SettleKingError);
    expect(error).toMatchObject({ status: 403, code: 'CAPABILITY_NOT_ENABLED' });
    expect(isCapabilityMissing(error)).toBe(true);
    expect(isCapabilityMissing(new SettleKingError('x', 403, 'FORBIDDEN'))).toBe(false);
  });

  it('reports SettleKing as unreachable when the request fails', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));

    await expect(client.getWidgetSession('ws_1')).rejects.toMatchObject({ status: 0, code: 'UNREACHABLE' });
  });
});
