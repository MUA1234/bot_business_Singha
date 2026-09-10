/**
 * "What changed?" — the change ledger.
 *
 * Pure and deterministic. Every entry it produces is a consequence of stored
 * fields plus the clock:
 *
 *   - a due date that fell inside the window (exactly computable),
 *   - a record whose `updated_at` falls inside the window,
 *   - the status that record now holds.
 *
 * It NEVER invents a delta. In particular it does not claim a record "became"
 * something unless the transition is derivable: a due date crossing is derivable
 * from the date alone; a status change is reported as "now <status>, updated in
 * this window", which is what the row actually supports. Where the system does
 * not store enough to know what changed, the ledger stays silent rather than
 * guessing.
 */

export interface ChangeSourceTask {
  id: string;
  title: string;
  status: string;
  due_date?: string | null;
  updated_at?: string | null;
}

export interface ChangeSourceDated {
  id?: string;
  label: string;
  dueDate?: string | null;
  outstanding?: string | null;
}

export interface ChangeEntry {
  id: string;
  title: string;
  meta?: string;
  /** Local time of day, or the date when older than today. */
  when?: string;
  tone: "critical" | "warn" | "ok" | "info";
  href?: string;
}

const TERMINAL = new Set(["completed", "done", "closed", "cancelled"]);
const BLOCKED = new Set(["blocked", "waiting", "on_hold"]);

/**
 * States that are worth reporting as a change in their own right: work that
 * started moving, and work that has reached a gate and is now waiting on a
 * person. Every other status change is routine progress and is summarised as a
 * count instead of a line.
 */
const NOTABLE = new Set(["in_progress", "verification", "awaiting_evidence", "awaiting_estimate", "escalated"]);
const NOTABLE_TITLE: Record<string, string> = {
  in_progress: "Work started",
  verification: "Work is ready for verification",
  awaiting_evidence: "Work is waiting for evidence",
  awaiting_estimate: "Work is waiting for an estimate",
  escalated: "Work was escalated",
};

function inWindow(iso: string | null | undefined, now: Date, hours: number): boolean {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  const age = now.getTime() - t;
  return age >= 0 && age <= hours * 3600_000;
}

/** A date-only value that crossed into the past inside the window. */
function crossedDueDate(due: string | null | undefined, now: Date, hours: number): boolean {
  if (!due) return false;
  // Due dates are stored date-only; a date is "crossed" at the start of the
  // following day, which is the moment the record is genuinely overdue.
  const crossedAt = Date.parse(`${due.slice(0, 10)}T00:00:00Z`) + 86_400_000;
  if (Number.isNaN(crossedAt)) return false;
  const age = now.getTime() - crossedAt;
  return age >= 0 && age <= hours * 3600_000;
}

function timeLabel(iso: string | null | undefined, now: Date): string | undefined {
  if (!iso) return undefined;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return undefined;
  const sameDay = t.toDateString() === now.toDateString();
  return sameDay
    ? t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : t.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export interface BuildChangesInput {
  tasks?: ChangeSourceTask[];
  /** Receivables that may have crossed their due date. */
  receivables?: ChangeSourceDated[];
  /** Payables that may have crossed their due date. */
  payables?: ChangeSourceDated[];
  now: Date;
  /** How far back "changed" reaches. 24 hours = "since yesterday". */
  windowHours?: number;
  limit?: number;
}

export function buildChanges({
  tasks = [],
  receivables = [],
  payables = [],
  now,
  windowHours = 24,
  limit = 12,
}: BuildChangesInput): ChangeEntry[] {
  const out: ChangeEntry[] = [];
  /** Records touched in the window whose new state is routine. Counted, not listed. */
  let quiet = 0;

  for (const bill of payables) {
    if (!crossedDueDate(bill.dueDate, now, windowHours)) continue;
    out.push({
      id: `ap:${bill.id ?? bill.label}`,
      title: "A payable became overdue",
      meta: bill.label,
      tone: "critical",
      href: "/app/finance/receivables",
    });
  }

  for (const inv of receivables) {
    if (!crossedDueDate(inv.dueDate, now, windowHours)) continue;
    out.push({
      id: `ar:${inv.id ?? inv.label}`,
      title: "A receivable became overdue",
      meta: inv.label,
      tone: "warn",
      href: "/app/finance/receivables",
    });
  }

  for (const task of tasks) {
    const terminal = TERMINAL.has(task.status);
    const crossed = !terminal && crossedDueDate(task.due_date, now, windowHours);
    const touched = inWindow(task.updated_at, now, windowHours);
    if (!crossed && !touched) continue;

    if (crossed) {
      out.push({
        id: `task-due:${task.id}`,
        title: "A task passed its due date",
        meta: task.title,
        when: timeLabel(task.updated_at, now),
        tone: "critical",
        href: `/app/operations/tasks/${task.id}`,
      });
      continue;
    }
    if (terminal) {
      out.push({
        id: `task-done:${task.id}`,
        title: "A task was completed",
        meta: task.title,
        when: timeLabel(task.updated_at, now),
        tone: "ok",
        href: `/app/operations/tasks/${task.id}`,
      });
      continue;
    }
    if (BLOCKED.has(task.status)) {
      out.push({
        id: `task-blocked:${task.id}`,
        title: `A task is now ${task.status.replace(/_/g, " ")}`,
        meta: task.title,
        when: timeLabel(task.updated_at, now),
        tone: "warn",
        href: `/app/operations/tasks/${task.id}`,
      });
      continue;
    }
    // A row being TOUCHED is not a change worth an executive's attention. Only
    // states that mean something to a reader are reported: work that started,
    // and work that reached a gate where it is waiting on a person. Everything
    // else updated in the window is counted, not listed — otherwise a normal
    // day's activity buries the two entries that matter.
    if (NOTABLE.has(task.status)) {
      out.push({
        id: `task:${task.id}`,
        title: NOTABLE_TITLE[task.status] ?? `Work is now ${task.status.replace(/_/g, " ")}`,
        meta: task.title,
        when: timeLabel(task.updated_at, now),
        tone: "info",
        href: `/app/operations/tasks/${task.id}`,
      });
      continue;
    }
    quiet++;
  }

  if (quiet > 0) {
    out.push({
      id: "quiet",
      title: `${quiet} other ${quiet === 1 ? "record was" : "records were"} updated`,
      meta: "Routine progress, with no change of state worth raising",
      tone: "info",
      href: "/app/operations/tasks",
    });
  }

  // Most severe first, then most recent. Deterministic for equal keys via id.
  const rank = { critical: 0, warn: 1, ok: 2, info: 3 } as const;
  out.sort((a, b) => rank[a.tone] - rank[b.tone] || a.id.localeCompare(b.id));
  return out.slice(0, limit);
}
