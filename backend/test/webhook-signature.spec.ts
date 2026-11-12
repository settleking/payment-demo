import { isoInstant } from '../src/settleking/settleking.client';
import { sign, TOLERANCE_SECONDS, verifyWebhook } from '../src/settleking/webhook-signature';

const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
const body = Buffer.from('{"id":"evt_1","type":"MERCHANT_PAYMENT_RECEIVED","data":{}}');
const now = 1_790_000_000;

function headers(overrides: Record<string, string> = {}) {
  return {
    'webhook-id': 'msg_1',
    'webhook-timestamp': String(now),
    'webhook-signature': `v1,${sign(secret, 'msg_1', now, body).toString('base64')}`,
    ...overrides,
  };
}

describe('verifyWebhook', () => {
  it('accepts a delivery signed with the endpoint secret', () => {
    expect(verifyWebhook(body, headers(), secret, now)).toEqual({ valid: true, id: 'msg_1', timestamp: now });
  });

  it('accepts any matching signature in a rotated list', () => {
    const signature = `v1,AAAA v1,${sign(secret, 'msg_1', now, body).toString('base64')}`;
    expect(verifyWebhook(body, headers({ 'webhook-signature': signature }), secret, now).valid).toBe(true);
  });

  it('rejects a tampered body', () => {
    const tampered = Buffer.from(body.toString().replace('evt_1', 'evt_2'));
    expect(verifyWebhook(tampered, headers(), secret, now)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects another endpoint’s secret', () => {
    const other = `whsec_${Buffer.from('another-secret-another-secret-00').toString('base64')}`;
    expect(verifyWebhook(body, headers(), other, now)).toEqual({ valid: false, reason: 'bad_signature' });
  });

  it('rejects old or future timestamps as replays', () => {
    expect(verifyWebhook(body, headers(), secret, now + TOLERANCE_SECONDS + 1)).toEqual({
      valid: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects deliveries without the Standard Webhooks headers', () => {
    expect(verifyWebhook(body, { 'webhook-id': 'msg_1' }, secret, now)).toEqual({
      valid: false,
      reason: 'missing_headers',
    });
  });

  it('refuses everything when no secret is configured', () => {
    expect(verifyWebhook(body, headers(), '', now)).toEqual({ valid: false, reason: 'no_secret' });
  });
});

describe('isoInstant', () => {
  it('reads SettleKing epoch seconds', () => {
    expect(isoInstant(1790536858.843)).toBe('2026-09-27T19:20:58.843Z');
  });

  it('keeps ISO strings and empty values', () => {
    expect(isoInstant('2026-09-27T10:00:00Z')).toBe('2026-09-27T10:00:00.000Z');
    expect(isoInstant(null)).toBeNull();
  });
});
