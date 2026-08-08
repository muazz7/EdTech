/**
 * Decimal-safe arithmetic for marks.
 *
 * Marks are `numeric(5,2)` in the database and cross the wire as strings. They
 * are never accumulated as JavaScript numbers: `0.1 + 0.2` is `0.30000000000004`,
 * and a quiz that totals 12.3 but computes 12.299999 fails a 12.3 pass mark it
 * should clear. On a certificate that is the difference between passing and not.
 *
 * Everything here works in integer hundredths and converts back once, at the
 * edge.
 */

/** Parses "12.34" into 1234. Throws on anything else — a silent NaN would be
 *  written to the database as a null score. */
export function parseMarks(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;

  const text = String(value).trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2})\d*)?$/.exec(text);
  if (!match) throw new Error(`Not a marks value: ${text}`);

  const [, sign, whole, fraction = ''] = match;
  const hundredths = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return sign === '-' ? -hundredths : hundredths;
}

/** 1234 becomes "12.34". Always two decimals, so the database never has to
 *  guess a scale. */
export function formatMarks(hundredths: number): string {
  const rounded = Math.round(hundredths);
  const sign = rounded < 0 ? '-' : '';
  const absolute = Math.abs(rounded);
  return `${sign}${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, '0')}`;
}

export function sumMarks(values: Array<string | number | null | undefined>): number {
  return values.reduce<number>((total, value) => total + parseMarks(value), 0);
}

/**
 * Integer percent, rounded half-up. Used for pass/fail against
 * `pass_percentage`, so it must not depend on float division landing exactly on
 * the boundary.
 */
export function percentOf(scoreHundredths: number, maxHundredths: number): number {
  if (maxHundredths <= 0) return 0;
  return Math.round((scoreHundredths * 100) / maxHundredths);
}
