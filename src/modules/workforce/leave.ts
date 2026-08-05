/**
 * Leave calculations (Architecture V2 change plan §7.1). Pure and deterministic:
 * inclusive calendar-day counting, overlap detection, and remaining entitlement. Days
 * are ordinary numbers (leave is a day count, not ledger money). It computes; the
 * approval decision and persistence are the caller's.
 */
const DAY = 86_400_000;

export interface DateRange {
  start: string; // ISO date
  end: string; // ISO date (inclusive)
}

/** Inclusive calendar days between two ISO dates (end >= start). */
export function calendarDays(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (!Number.isFinite(s) || !Number.isFinite(e) || e < s) return 0;
  return Math.floor((e - s) / DAY) + 1;
}

/** Do two inclusive date ranges overlap? */
export function overlaps(a: DateRange, b: DateRange): boolean {
  const aS = new Date(a.start).getTime();
  const aE = new Date(a.end).getTime();
  const bS = new Date(b.start).getTime();
  const bE = new Date(b.end).getTime();
  if ([aS, aE, bS, bE].some((n) => !Number.isFinite(n))) return false;
  return aS <= bE && bS <= aE;
}

/** Total days across approved leave ranges. */
export function usedLeaveDays(approved: DateRange[]): number {
  return approved.reduce((sum, r) => sum + calendarDays(r.start, r.end), 0);
}

/** Remaining entitlement (never negative below zero for display; can be exceeded). */
export function remainingLeave(entitlementDays: number, approved: DateRange[]): number {
  return entitlementDays - usedLeaveDays(approved);
}
