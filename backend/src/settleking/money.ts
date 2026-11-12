import { Money } from './settleking.types';

/**
 * The studio keeps prices in cents; SettleKing's merchant API speaks Money, a currency code and a
 * decimal string in major units ({ currency: 'USD', value: '25.00' }). These convert at the edge
 * without floating-point arithmetic. The studio sells in USD only (two decimals).
 */
export function toMoney(cents: number, currency: string): Money {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new RangeError(`Not an amount in cents: ${cents}`);
  const whole = Math.trunc(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0');
  return { currency, value: `${whole}.${fraction}` };
}

/** The amount in cents, or null when it is not a well-formed two-decimal amount. */
export function toCents(money: Money | null | undefined): number | null {
  const match = /^(\d{1,13})(?:\.(\d{1,2}))?$/.exec(money?.value ?? '');
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
}

/** Whether {@code money} is exactly {@code cents} of {@code currency}. */
export function isAmount(money: Money | null | undefined, cents: number, currency: string): boolean {
  return money?.currency === currency && toCents(money) === cents;
}
