/**
 * The wire's decimal strings, in one place.
 *
 * Prices, quantities, and candle fields cross the boundary as decimal strings
 * (`docs/PROTOCOL.md`), and the client renders them from those strings — no
 * float ever decides what a price looks like on screen (`lib/format.ts`). The
 * guard (`lib/protocol.ts`) and the display helpers used to define the shape
 * separately; this module owns the one pattern and the one predicate, so the
 * two doors cannot disagree about what a decimal is.
 */

/** One canonical decimal shape: optional sign, digits, optional `.digits`. */
export const DECIMAL_PATTERN = /^(-?\d+)(?:\.(\d+))?$/;

/**
 * A decimal string as the wire writes it: `"65123.45"`, `"1.500000"`.
 * A plain alias, not a brand: `lib/format.ts` must still accept
 * possibly-invalid input (and render it as `—`), so the guard stays the
 * boundary and the type stays documentation.
 */
export type DecimalString = string;

export function isDecimalString(value: unknown): value is DecimalString {
  return typeof value === "string" && DECIMAL_PATTERN.test(value);
}

/**
 * Split a decimal string into whole and fraction parts, or `null` if it is
 * not one.
 *
 * Splitting on `.` is not enough: `"1.2.3"` would silently render as `"1.2"`.
 * Malformed values must be visibly wrong (`—`), never quietly truncated.
 */
export function splitDecimal(value: string): { whole: string; fraction: string | null } | null {
  const match = DECIMAL_PATTERN.exec(value);
  if (match === null) {
    return null;
  }
  return { whole: match[1], fraction: match[2] ?? null };
}
