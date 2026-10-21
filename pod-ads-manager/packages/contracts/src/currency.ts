import { DomainError } from './errors';

/**
 * ISO 4217 minor-unit exponents for currencies we accept. Deliberately an
 * allowlist: an unknown currency is rejected instead of assuming 2 decimals.
 * Source: ISO 4217 amendment list (exponents stable for these codes).
 */
const EXPONENTS: Readonly<Record<string, number>> = {
  USD: 2, EUR: 2, GBP: 2, AUD: 2, CAD: 2, NZD: 2, SGD: 2, CHF: 2, SEK: 2, NOK: 2, DKK: 2,
  PLN: 2, MXN: 2, BRL: 2, THB: 2, PHP: 2, MYR: 2, HKD: 2, INR: 2, IDR: 2,
  VND: 0, JPY: 0, KRW: 0, CLP: 0,
  KWD: 3, BHD: 3, JOD: 3, OMR: 3, TND: 3,
};

export function currencyExponent(currency: string): number {
  const e = EXPONENTS[currency];
  if (e === undefined) throw new DomainError('INPUT_INVALID', `Tiền tệ ${currency} chưa có trong danh sách hỗ trợ`);
  return e;
}

export const isSupportedCurrency = (c: string): boolean => EXPONENTS[c] !== undefined;

/** Display only — never feed the result back into calculations. */
export function formatMinor(amountMinor: number, currency: string): string {
  const exp = currencyExponent(currency);
  const sign = amountMinor < 0 ? '-' : '';
  const abs = Math.abs(amountMinor).toString().padStart(exp + 1, '0');
  const whole = exp === 0 ? abs : abs.slice(0, -exp);
  const frac = exp === 0 ? '' : `.${abs.slice(-exp)}`;
  return `${sign}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac} ${currency}`;
}
