import { describe, expect, it } from 'vitest';
import { canonicalHash, canonicalize, currencyExponent, formatMinor, isSupportedCurrency } from '@pod/contracts';

describe('canonical JSON', () => {
  it('sorts keys, drops undefined, keeps array order', () => {
    expect(canonicalize({ b: 1, a: [3, 1], c: undefined, d: null, e: 'x', f: true, g: false })).toBe('{"a":[3,1],"b":1,"d":null,"e":"x","f":true,"g":false}');
  });
  it('hash ignores key order but not values', () => {
    expect(canonicalHash({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
  });
  it('rejects non-finite numbers and unsupported types', () => {
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
    expect(() => canonicalize({ a: () => 1 })).toThrow();
    expect(() => canonicalize({ a: 1n })).toThrow();
  });
  it('escapes unicode consistently', () => {
    expect(canonicalize({ 'tên': 'Áo thun "Halloween"' })).toBe('{"tên":"Áo thun \\"Halloween\\""}');
  });
});

describe('currency minor units', () => {
  it('knows non-2-decimal currencies', () => {
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('VND')).toBe(0);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
  });
  it('rejects unknown currency instead of assuming 2 decimals', () => {
    expect(isSupportedCurrency('XYZ')).toBe(false);
    expect(() => currencyExponent('XYZ')).toThrow(/chưa có/);
  });
  it('formats for display only', () => {
    expect(formatMinor(123456, 'USD')).toBe('1,234.56 USD');
    expect(formatMinor(5, 'USD')).toBe('0.05 USD');
    expect(formatMinor(-150, 'USD')).toBe('-1.50 USD');
    expect(formatMinor(250000, 'VND')).toBe('250,000 VND');
    expect(formatMinor(1234, 'KWD')).toBe('1.234 KWD');
  });
});
