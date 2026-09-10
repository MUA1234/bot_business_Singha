/**
 * Temporal normalisation for the loaders.
 *
 * Every adapter declares its date and timestamp fields as `string | null`, and `pg` hands back
 * `date` and `timestamptz` columns as JavaScript `Date` objects. These two helpers are the one
 * place that difference is reconciled, so a detector never receives an object where its contract
 * says string (defect R2S-F-005).
 *
 * ── Why there are TWO helpers, and why `isoDate` does not use toISOString ────────────────────
 *
 * A `timestamptz` is an INSTANT. `toISOString()` is exactly right for it: the same moment,
 * written in UTC.
 *
 * A `date` is a CALENDAR DAY with no time and no zone — an expiry, a due date, a period start.
 * `pg` materialises it as a Date at LOCAL midnight, so in any timezone east of UTC,
 * `toISOString().slice(0, 10)` moves it to the PREVIOUS DAY:
 *
 *     TZ=Asia/Colombo  (UTC+5:30)
 *     date column      2026-09-02
 *     pg Date          Wed Sep 02 2026 00:00:00 local
 *     toISOString()    2026-09-01T18:30:00.000Z   ->  "2026-09-01"   ✗ off by one
 *
 * That is defect R2S-F-007, and it is not a rounding curiosity: this system runs a Sri Lankan
 * business at UTC+5:30, so EVERY licence expiry, insurance expiry, invoice due date and objective
 * window boundary would have been read one day early. A licence expiring today would be reported
 * as already expired; a due date on the 1st would be read as the last day of the previous month.
 * The test suite runs in UTC, where the bug is invisible.
 *
 * So `isoDate` reads the LOCAL calendar components — the day `pg` actually gave us — and never
 * converts through UTC.
 */

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Normalise a TIMESTAMP to an ISO instant string, or null.
 *
 * Null for an absent or unreadable value, never a fabricated time.
 */
export function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Normalise a DATE column to a `YYYY-MM-DD` calendar day, or null.
 *
 * Uses local components for a Date (see the module header) and takes the leading day from a
 * string that already carries one, so a value that arrives as text is not re-parsed through a
 * timezone at all.
 */
export function isoDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;

  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    // LOCAL components, deliberately. See the header: converting through UTC shifts the day.
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }

  const s = String(v);
  // Already a calendar day (possibly with a time appended) — take it verbatim rather than
  // parsing and re-formatting, which would reintroduce a zone conversion.
  const leading = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (leading) return `${leading[1]}-${leading[2]}-${leading[3]}`;

  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
