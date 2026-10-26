/** Money is always an integer number of minor units (1 KES = 100). Never a float. */
export class MoneyError extends Error {}

export function assertMinor(n: unknown, label = 'amount'): asserts n is number {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) {
    throw new MoneyError(`${label} must be a safe integer number of minor units`);
  }
}

/** Whole shillings -> minor units. */
export function kes(shillings: number): number {
  if (!Number.isSafeInteger(shillings)) throw new MoneyError('shillings must be an integer');
  return shillings * 100;
}

export function formatKes(minor: number): string {
  assertMinor(minor);
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const whole = Math.floor(abs / 100);
  const cents = abs % 100;
  return `KES ${sign}${whole}${cents ? '.' + String(cents).padStart(2, '0') : ''}`;
}

/** Daraja accepts whole shillings only. Throws if the amount has a fractional shilling. */
export function toMpesaShillings(minor: number): number {
  assertMinor(minor);
  if (minor <= 0 || minor % 100 !== 0) {
    throw new MoneyError('M-Pesa amounts must be a positive whole number of shillings');
  }
  return minor / 100;
}
