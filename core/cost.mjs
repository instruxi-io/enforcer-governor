// What a receipt's cost_usd may carry. Harness-neutral: the rule comes from the
// governance column it lands in, not from where the dollar figure was measured.
export const COST_MAX = 1e6;

/**
 * A dollar figure as a receipt may carry it, or undefined when there is no
 * honest number to send.
 *
 * Undefined rather than 0: the server stores a missing cost as 0 and reads that
 * back as "the edge never reported one", so a fabricated zero and a real zero
 * are the same row. Sending nothing keeps that distinction true.
 *
 * Rounded to six decimals because the column is numeric(12,6) — shipping a full
 * float would be rounded at the far end anyway, and then the receipt's hash
 * would cover a number nobody stored.
 */
export function costUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  // Bound the ROUNDED value, not the raw one: 999999.9999999 is inside the
  // limit until six-decimal rounding lifts it to exactly 1e6, which the server
  // then refuses — and a refused receipt is one the install resends forever.
  const rounded = Math.round(n * 1e6) / 1e6;
  return rounded >= COST_MAX ? undefined : rounded;
}
