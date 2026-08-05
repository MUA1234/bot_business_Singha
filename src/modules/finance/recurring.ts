/**
 * Expand a recurring obligation into dated cash outflows within a horizon
 * (Architecture V2 change plan §8.5). Pure and deterministic. Amounts stay decimal
 * strings (Constitution §8); dates step by the cadence from `nextDue`.
 */
import type { CashFlowItem } from "@/management/ai-manager/forecast";

export type Cadence = "weekly" | "monthly" | "quarterly" | "annual";

const DAY = 86_400_000;

function step(date: Date, cadence: Cadence): Date {
  const d = new Date(date);
  if (cadence === "weekly") d.setDate(d.getDate() + 7);
  else if (cadence === "monthly") d.setMonth(d.getMonth() + 1);
  else if (cadence === "quarterly") d.setMonth(d.getMonth() + 3);
  else d.setFullYear(d.getFullYear() + 1);
  return d;
}

/** Occurrences of a recurring obligation from `nextDue` through the horizon window. */
export function expandRecurring(
  cadence: Cadence,
  amount: string,
  nextDue: string,
  horizonDays: number,
  now = new Date(),
): CashFlowItem[] {
  const out: CashFlowItem[] = [];
  const start = now.getTime();
  const end = start + Math.max(1, horizonDays) * DAY;
  let cursor = new Date(nextDue);
  if (!Number.isFinite(cursor.getTime())) return out;

  // Fast-forward past occurrences (obligations already due in the past aren't forecast).
  let guard = 0;
  while (cursor.getTime() < start && guard < 800) {
    cursor = step(cursor, cadence);
    guard++;
  }
  while (cursor.getTime() <= end && guard < 800) {
    out.push({ date: cursor.toISOString().slice(0, 10), amount });
    cursor = step(cursor, cadence);
    guard++;
  }
  return out;
}
