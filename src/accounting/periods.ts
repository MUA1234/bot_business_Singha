/**
 * Accounting period helpers (Architecture V2 change plan §8.1). Pure and
 * deterministic: generate the twelve monthly periods of a fiscal year. Closing a
 * period locks the ledger against it (enforced by the post_manual_journal RPC);
 * reopening is a controlled, audited action.
 */
export interface PeriodSpec {
  name: string; // e.g. "2026-03"
  start_date: string; // ISO date
  end_date: string; // ISO date (last day of the month)
}

/** The 12 calendar-month periods for a given year. */
export function monthlyPeriods(year: number): PeriodSpec[] {
  const out: PeriodSpec[] = [];
  for (let m = 0; m < 12; m++) {
    const start = new Date(Date.UTC(year, m, 1));
    const end = new Date(Date.UTC(year, m + 1, 0)); // day 0 of next month = last day of this
    out.push({
      name: `${year}-${String(m + 1).padStart(2, "0")}`,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10),
    });
  }
  return out;
}
