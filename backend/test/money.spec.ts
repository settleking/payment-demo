import { isAmount, toCents, toMoney } from '../src/settleking/money';

describe('money', () => {
  it('writes cents as a two-decimal string', () => {
    expect(toMoney(2500, 'USD')).toEqual({ currency: 'USD', value: '25.00' });
    expect(toMoney(5, 'USD')).toEqual({ currency: 'USD', value: '0.05' });
    expect(() => toMoney(1.5, 'USD')).toThrow(RangeError);
  });

  it('reads a decimal string back as cents', () => {
    expect(toCents({ currency: 'USD', value: '25.00' })).toBe(2500);
    expect(toCents({ currency: 'USD', value: '25.5' })).toBe(2550);
    expect(toCents({ currency: 'USD', value: '25' })).toBe(2500);
    expect(toCents({ currency: 'USD', value: '25.001' })).toBeNull();
    expect(toCents({ currency: 'USD', value: '-1.00' })).toBeNull();
  });

  it('matches only the same amount in the same currency', () => {
    expect(isAmount({ currency: 'USD', value: '25.00' }, 2500, 'USD')).toBe(true);
    expect(isAmount({ currency: 'EUR', value: '25.00' }, 2500, 'USD')).toBe(false);
    expect(isAmount(undefined, 2500, 'USD')).toBe(false);
  });
});
