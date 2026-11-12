import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a webhook's timestamp may be from now; older deliveries are treated as replays. */
export const TOLERANCE_SECONDS = 5 * 60;

export type SignatureCheck =
  | { valid: true; id: string; timestamp: number }
  | { valid: false; reason: 'missing_headers' | 'stale_timestamp' | 'bad_signature' | 'no_secret' };

/**
 * Verifies a SettleKing webhook. SettleKing signs with Standard Webhooks (the scheme Svix uses):
 * {@code webhook-signature} holds space-separated {@code v1,<base64 HMAC-SHA256>} entries over
 * {@code "<webhook-id>.<webhook-timestamp>.<raw body>"}, keyed with the base64 part of the
 * endpoint's {@code whsec_} secret. The raw bytes must be used, never re-serialized JSON.
 */
export function verifyWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): SignatureCheck {
  if (!secret) return { valid: false, reason: 'no_secret' };
  const id = header(headers, 'webhook-id');
  const timestampText = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestampText || !signatures) return { valid: false, reason: 'missing_headers' };

  const timestamp = Number(timestampText);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > TOLERANCE_SECONDS) {
    return { valid: false, reason: 'stale_timestamp' };
  }

  const expected = sign(secret, id, timestamp, rawBody);
  const matches = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches ? { valid: true, id, timestamp } : { valid: false, reason: 'bad_signature' };
}

/** The raw HMAC for one delivery; exported for tests and local tooling. */
export function sign(secret: string, id: string, timestamp: number, rawBody: Buffer | string): Buffer {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key)
    .update(`${id}.${timestamp}.`)
    .update(rawBody)
    .digest();
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}
