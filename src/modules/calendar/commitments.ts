/**
 * The commitments calendar.
 *
 * Pure and deterministic. It does NOT introduce a calendar model, a new table or
 * a scheduling concept: it gathers the dates the business has ALREADY committed
 * to across existing records — task due dates, obligations, licence expiries,
 * contract renewals, insurance expiries, expected purchase-order payments,
 * expected commitment settlements and approved leave — and arranges them on one
 * planning surface.
 *
 * Two rules keep it honest:
 *
 *   1. A record with no date is NOT placed. It is counted separately and
 *      reported as undated, because guessing a date is worse than saying none
 *      was recorded.
 *
 *   2. Nothing is generated. Every entry corresponds to exactly one row.
 */

export type CommitmentKind =
  | "task"
  | "obligation"
  | "licence"
  | "contract"
  | "insurance"
  | "purchase-order"
  | "commitment"
  | "leave";

export interface CommitmentEntry {
  id: string;
  /** Date-only, ISO (YYYY-MM-DD). */
  date: string;
  kind: CommitmentKind;
  title: string;
  detail?: string;
  href?: string;
  /** True when the date has passed and the record is not closed. */
  overdue: boolean;
}

export interface CommitmentSource {
  id: string;
  date: string | null | undefined;
  title: string;
  detail?: string;
  href?: string;
  /** A record in a terminal state is placed but never marked overdue. */
  closed?: boolean;
}

export interface BuildCalendarInput {
  now: Date;
  sources: { kind: CommitmentKind; items: CommitmentSource[] }[];
  /** How far forward the surface reaches. */
  horizonDays?: number;
  /** How far back overdue items are still shown. */
  lookbackDays?: number;
}

export interface CalendarDay {
  date: string;
  entries: CommitmentEntry[];
}

export interface BuiltCalendar {
  /** Days that have at least one entry, earliest first. */
  days: CalendarDay[];
  /** Entries whose date has passed and whose record is not closed. */
  overdue: CommitmentEntry[];
  /** Records that carry no date at all, by kind — reported, never placed. */
  undated: { kind: CommitmentKind; count: number }[];
  totalPlaced: number;
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function buildCommitmentCalendar({
  now,
  sources,
  horizonDays = 60,
  lookbackDays = 30,
}: BuildCalendarInput): BuiltCalendar {
  const today = isoDay(now);
  const from = isoDay(new Date(now.getTime() - lookbackDays * 86_400_000));
  const to = isoDay(new Date(now.getTime() + horizonDays * 86_400_000));

  const byDay = new Map<string, CommitmentEntry[]>();
  const overdue: CommitmentEntry[] = [];
  const undated: { kind: CommitmentKind; count: number }[] = [];
  let totalPlaced = 0;

  for (const source of sources) {
    let missing = 0;
    for (const item of source.items) {
      const raw = item.date ? String(item.date).slice(0, 10) : "";
      if (!raw || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        missing++;
        continue;
      }
      if (raw < from || raw > to) continue;

      const entry: CommitmentEntry = {
        id: `${source.kind}:${item.id}`,
        date: raw,
        kind: source.kind,
        title: item.title,
        detail: item.detail,
        href: item.href,
        overdue: !item.closed && raw < today,
      };
      const list = byDay.get(raw) ?? [];
      list.push(entry);
      byDay.set(raw, list);
      totalPlaced++;
      if (entry.overdue) overdue.push(entry);
    }
    if (missing > 0) undated.push({ kind: source.kind, count: missing });
  }

  const days: CalendarDay[] = [...byDay.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, entries]) => ({
      date,
      // Within a day, overdue first, then by kind then title — fully deterministic.
      entries: entries.sort(
        (a, b) =>
          Number(b.overdue) - Number(a.overdue) ||
          a.kind.localeCompare(b.kind) ||
          a.title.localeCompare(b.title),
      ),
    }));

  overdue.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));

  return { days, overdue, undated, totalPlaced };
}
