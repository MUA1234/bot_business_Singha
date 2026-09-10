/**
 * Bounded pagination and reconciliation cursors (R2S-P).
 *
 * The 500-row cap made a large company's records invisible: beyond it the sweep was truncated,
 * and until R2S-F-008 it was not even reported. Removing the cap without creating an unbounded
 * query means paging — and paging a table that people are editing while you read it is where the
 * interesting failures live.
 *
 * ── Three strategies, because the sources are genuinely different ────────────────────────────
 *
 *   keyset_updated   a table with a reliable `updated_at`. Cursor is COMPOUND — (updated_at, id)
 *                    — because `updated_at` is not unique, and a bare timestamp cursor silently
 *                    skips one of two rows written in the same millisecond.
 *
 *   sweep_by_id      a mutable table with NO update timestamp. `created_at` must never be used
 *                    as a mutation cursor: a row edited today keeps its creation date and would
 *                    never be re-read. Instead the sweep pages the whole table by primary key and
 *                    STARTS AGAIN when it finishes, so an edit to an old record is observed
 *                    within one sweep period rather than never.
 *
 *   latest_per_key   a sampled measurement. One row per subject, always the newest, paged by the
 *                    subject key. Obsolete samples are never returned at all.
 *
 * OFFSET is used nowhere. It re-scans everything it skips, and its results shift under
 * concurrent inserts and deletes — the two things a reconciliation sweep must not do.
 */

/** Rows read per source per cycle. */
export const PAGE_SIZE = 200;
/** Rows read by the priority pre-pass, which never advances a cursor. */
export const PRIORITY_PAGE = 50;
/** Rows read across ALL sources in one cycle, so one growing source cannot starve the rest. */
export const CYCLE_ROW_BUDGET = 2000;

/**
 * How far a `keyset_updated` cursor is rewound before it is used.
 *
 * A writer whose transaction commits AFTER a later-timestamped one has already been read would
 * otherwise fall permanently behind the cursor — the classic late-writer loss. Re-reading a
 * minute of rows costs almost nothing; losing one silently costs a management item that never
 * appears. Duplicates are absorbed by identity-key deduplication in `ingest`, which is exactly
 * what that mechanism is for.
 */
/**
 * A bounded integer from the environment.
 *
 * These are tuning constants, not policy: the right overlap depends on how long a writing
 * transaction stays open under real load, which THIS REPOSITORY HAS NOT MEASURED. They are
 * configurable so a staging measurement can set them without a code change, and clamped so a
 * typo cannot silently disable a bound. Production values require staging evidence — see
 * docs/product-recovery/r2s-p/02-CURSOR-HANDOFF.md.
 */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) return fallback;
  return n;
}

export const OVERLAP_MS = envInt("KERNEL_OVERLAP_MS", 60_000, 0, 3_600_000);

/**
 * How many rows the periodic RECONCILIATION sweep visits per source per cycle.
 *
 * The incremental keyset cursor moves forward through `updated_at` and never goes back, so a
 * row whose timestamp lands BEHIND the cursor — a backfill, an import carrying historical
 * timestamps, a writer on a clock that is behind, a commit later than the overlap — would
 * never be read again. The overlap window narrows that hole; it cannot close it, because it
 * is a fixed guess about commit latency.
 *
 * So correctness does not rest on it. Every `keyset_updated` source ALSO runs a full sweep by
 * primary key that restarts when it finishes, exactly as the type-3 sources do. Discovery of
 * any row is then bounded by table size / this page size, in cycles — independent of every
 * timestamp in the table.
 */
export const RECONCILE_PAGE = envInt("KERNEL_RECONCILE_PAGE", 100, 1, 10_000);

/**
 * The cursor key for a source's reconciliation sweep.
 *
 * It is a SECOND, independent position over the same table, so it lives under its own key
 * rather than sharing the incremental one. `#` cannot appear in a registered source name.
 */
/**
 * The most pages one reconciliation generation may take before it is CLOSED UNFINISHED.
 *
 * The `created_at` fence is not absolute. It excludes rows created after the generation
 * began, which stops ordinary write traffic from extending it — but a writer that BACKDATES
 * `created_at` inserts rows *inside* the boundary, and a steady stream of those extends the
 * generation exactly as an unfenced sweep was extended. An importer replaying history, an ETL
 * preserving source timestamps, or a clock far behind will all do this without malice.
 *
 * So the generation is also bounded by WORK. On reaching this many pages without finishing,
 * the generation is abandoned and a new one starts with a new fence. Abandoned is not
 * finished: it stamps no completion, it licenses no resolution, and the cycle says so. The
 * new generation restarts from the beginning of the table, so rows left behind the old
 * cursor are reconsidered rather than stranded.
 *
 * Read at CALL time, not at module load, so a deployment — or a test — can bound it without
 * a restart.
 */
export function maxGenerationPages(): number {
  return envInt("KERNEL_MAX_GENERATION_PAGES", 100, 1, 1_000_000);
}

/**
 * Rows the EARLIER-RANGE rescan may re-read per source per cycle.
 *
 * Forward coverage and backdated recovery are two different jobs, and one sweep cannot do
 * both: a sweep that restarts to catch backdated rows never reaches the end of the table,
 * and a sweep that only goes forward never sees what was inserted behind it. So they are
 * separate positions with separate budgets — neither can starve the other, and neither has
 * to compromise.
 */
export const RESCAN_PAGE = envInt("KERNEL_RESCAN_PAGE", 50, 1, 10_000);

/** The cursor key for a source's earlier-range rescan. */
export function rescanSourceKey(source: string): string {
  return `${source}#rescan`;
}

export function reconcileSourceKey(source: string): string {
  return `${source}#reconcile`;
}

export type CursorKind = "keyset_updated" | "sweep_by_id" | "latest_per_key" | "none";

/**
 * A cursor position.
 *
 * Deliberately tiny and deliberately typed. Cursor state must never become a place to park a
 * message body, an amount or a name, so the shape simply has nowhere to put one — and draft unit
 * 018 refuses any other key at the database as well.
 */
export type Cursor =
  | { kind: "keyset_updated"; updatedAt: string; id: string }
  | {
      kind: "sweep_by_id";
      id: string;
      /**
       * The generation's UPPER BOUNDARY, captured when the generation started.
       *
       * A sweep with no upper bound never finishes under sustained inserts: rows arriving
       * during the pass land ahead of the cursor and keep extending it, so the generation
       * never wraps and `ceil(N / page)` describes nothing. Fixing the boundary at the start
       * makes N a definite number — the rows created at or before this instant — and hands
       * everything newer to the NEXT generation rather than to this one.
       */
      fence?: string;
    }
  | { kind: "latest_per_key"; key: string }
  | { kind: "none" };

/** What one page of a source looked like. */
export interface Page<T> {
  rows: T[];
  /** Where to resume. Null means the sweep reached the end and should restart. */
  next: Cursor | null;
  /** True when this page exhausted the source — a short page. */
  complete: boolean;
  /** How many rows were actually inspected, for the honest runtime status. */
  inspected: number;
}

/** The keys a stored cursor payload may contain. Anything else is refused. */
export const PERMITTED_CURSOR_KEYS: ReadonlySet<string> = new Set([
  "kind", "updatedAt", "id", "key", "fence",
]);

/** A uuid, in the only shape PostgreSQL will accept for a uuid column. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * SQLSTATEs that mean THE CURSOR VALUE was not acceptable to the column — and nothing else.
 *
 * Deliberately tiny, and deliberately not message matching. Restarting a sweep is a real
 * action: it re-reads a table and discards a recorded position. It is the right answer to a
 * position this schema cannot use, and the WRONG answer to a permission denial, a dropped
 * column, a timeout, an unavailable database or an isolation failure — each of which must
 * stay visible as a failure rather than being converted into a busy retry that hides it.
 *
 *   22P02  invalid_text_representation   e.g. a non-uuid where a uuid is required
 *   22007  invalid_datetime_format       an unparseable timestamp bound
 *   22008  datetime_field_overflow       a timestamp outside the representable range
 *   22003  numeric_value_out_of_range    a bound the column cannot hold
 */
export const UNUSABLE_CURSOR_SQLSTATES: ReadonlySet<string> = new Set([
  "22P02", "22007", "22008", "22003",
]);

/**
 * The timestamp forms PostgreSQL will accept for a `timestamptz` bound.
 *
 * `Date.parse` is far more permissive than PostgreSQL — it accepts "March 3 2026" and other
 * shapes the database would reject — so validating with it alone would pass a cursor straight
 * into a query that then fails. This is the intersection, checked here rather than discovered
 * there.
 *
 * The offset must allow a BARE HOUR. PostgreSQL writes `+00`, not `+00:00`, and requiring
 * four digits declared every real cursor corrupt: the sweep reset on every cycle, stayed
 * permanently partial and never licensed resolution — the wedge this guard exists to prevent,
 * arriving through the guard itself. Validation stricter than the database's own output is
 * not caution; it is a fault.
 */
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;

/** Why a stored position could not be used. Codes, not sentences, and never the value. */
export type CursorProblem =
  | "kind_mismatch"
  | "invalid_id"
  | "invalid_timestamp"
  | "invalid_fence";

export interface CursorVerdict {
  ok: boolean;
  problem?: CursorProblem;
}

/**
 * Validate a stored position ON ITS OWN — no source rows, no query, no side effects.
 *
 * This is the ONLY thing permitted to trigger a sweep restart, and the reason is an argument
 * about evidence. The previous design inferred "the cursor was at fault" from a retry that
 * succeeded when reading from the beginning. That inference is not sound: the first page
 * succeeding says nothing about a malformed row waiting on page nine, and a transient error
 * that clears on retry would be misread as a corrupt position and quietly disguised as a
 * cursor reset. A SQLSTATE cannot separate those either — `22P02` is raised just as readily
 * by row data as by a bad bound.
 *
 * So attribution no longer comes from watching a query fail. Either the position itself is
 * demonstrably unusable — checked here, against the shapes the database accepts — or it is
 * not, and every subsequent failure belongs to the source and is reported as one.
 *
 * `expectedKind` catches a cursor written for a DIFFERENT source or by a different version:
 * a keyset position stored against a sweep source is not merely wrong, it is unusable.
 */
export function validateCursorEnvelope(
  cursor: Cursor | null,
  expectedKind: CursorKind,
): CursorVerdict {
  if (!cursor || cursor.kind === "none") return { ok: true };
  if (cursor.kind !== expectedKind) return { ok: false, problem: "kind_mismatch" };

  const idOk = (v: string) => v === "" || UUID_RE.test(v);
  const stampOk = (v: string) => TIMESTAMP_RE.test(v) && !Number.isNaN(Date.parse(v));

  switch (cursor.kind) {
    case "sweep_by_id":
      if (!idOk(cursor.id)) return { ok: false, problem: "invalid_id" };
      if (cursor.fence !== undefined && !stampOk(cursor.fence)) {
        return { ok: false, problem: "invalid_fence" };
      }
      return { ok: true };
    case "keyset_updated":
      if (!stampOk(cursor.updatedAt)) return { ok: false, problem: "invalid_timestamp" };
      if (!idOk(cursor.id)) return { ok: false, problem: "invalid_id" };
      return { ok: true };
    default:
      return { ok: true };
  }
}

/**
 * Is this error the database saying "that POSITION is not a value I can use"?
 *
 * RETAINED FOR DIAGNOSIS ONLY — it no longer decides anything. A 22-class code is raised by
 * malformed row DATA and by a schema mismatch exactly as readily as by a bad bound, so it
 * cannot attribute a failure to the cursor. `validateCursorEnvelope` decides that, alone.
 *
 * Classified by SQLSTATE only. A message match would eventually catch a sentence that merely
 * mentions a uuid, and convert a genuine outage into a silent restart loop.
 */
export function isUnusableCursorError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && UNUSABLE_CURSOR_SQLSTATES.has(code);
}

/**
 * Can this stored position be used against this schema at all?
 *
 * Checked BEFORE the query, because explicit validation is a better answer than provoking an
 * error and classifying it: every id in every paged table is a uuid, and every keyset bound
 * is a timestamp. A position failing this was written by a different version, or corrupted.
 */
export function cursorIsUsable(cursor: Cursor | null): boolean {
  if (!cursor) return true;
  switch (cursor.kind) {
    case "sweep_by_id":
      if (cursor.fence !== undefined && Number.isNaN(Date.parse(cursor.fence))) return false;
      return cursor.id === "" || UUID_RE.test(cursor.id);
    case "keyset_updated":
      if (Number.isNaN(Date.parse(cursor.updatedAt))) return false;
      return cursor.id === "" || UUID_RE.test(cursor.id);
    default:
      return true;
  }
}

export class CursorRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorRejected";
  }
}

/**
 * Validate a cursor that came back from storage.
 *
 * Cursor state is server-written, but it is still READ back and used to build a query bound, so
 * it is validated on the way in. A tampered or corrupt cursor must fail loudly rather than
 * silently reposition a sweep — repositioning it to the end would make a whole domain look empty.
 */
export function parseCursor(raw: unknown): Cursor | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "object") throw new CursorRejected("a cursor must be an object");

  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!PERMITTED_CURSOR_KEYS.has(k)) {
      throw new CursorRejected(`cursor may not carry "${k}" — cursor state holds position, never content`);
    }
  }

  switch (o.kind) {
    case "keyset_updated":
      if (typeof o.updatedAt !== "string" || typeof o.id !== "string") {
        throw new CursorRejected("keyset_updated needs a string updatedAt and id");
      }
      if (Number.isNaN(Date.parse(o.updatedAt))) {
        throw new CursorRejected("keyset_updated carries an unreadable updatedAt");
      }
      return { kind: "keyset_updated", updatedAt: o.updatedAt, id: o.id };
    case "sweep_by_id": {
      if (typeof o.id !== "string") throw new CursorRejected("sweep_by_id needs a string id");
      if (o.fence !== undefined) {
        if (typeof o.fence !== "string" || Number.isNaN(Date.parse(o.fence))) {
          throw new CursorRejected("sweep_by_id carries an unreadable fence");
        }
        return { kind: "sweep_by_id", id: o.id, fence: o.fence };
      }
      return { kind: "sweep_by_id", id: o.id };
    }
    case "latest_per_key":
      if (typeof o.key !== "string") throw new CursorRejected("latest_per_key needs a string key");
      return { kind: "latest_per_key", key: o.key };
    case "none":
      return { kind: "none" };
    default:
      throw new CursorRejected(`unknown cursor kind: ${String(o.kind)}`);
  }
}

/** The cursor that resumes after this page, or null when the page exhausted the source. */
export function nextCursorFrom<T extends Record<string, unknown>>(
  kind: CursorKind,
  rows: T[],
  pageSize: number,
  fields: { id?: string; updatedAt?: string; key?: string } = {},
): { next: Cursor | null; complete: boolean } {
  // A SHORT page means the source is exhausted. The sweep wraps, and for a type-3 source that is
  // what makes a reconciliation generation complete.
  if (rows.length < pageSize) return { next: null, complete: true };

  const last = rows[rows.length - 1]!;
  const idField = fields.id ?? "id";

  switch (kind) {
    case "keyset_updated": {
      const uField = fields.updatedAt ?? "updated_at";
      const at = last[uField];
      const id = last[idField];
      if (typeof id !== "string" || (typeof at !== "string" && !(at instanceof Date))) {
        // Cannot build a safe boundary. Stopping is correct: advancing on a guess would skip rows.
        return { next: null, complete: false };
      }
      return {
        next: {
          kind: "keyset_updated",
          updatedAt: at instanceof Date ? at.toISOString() : at,
          id,
        },
        complete: false,
      };
    }
    case "sweep_by_id": {
      const id = last[idField];
      if (typeof id !== "string") return { next: null, complete: false };
      return { next: { kind: "sweep_by_id", id }, complete: false };
    }
    case "latest_per_key": {
      const keyField = fields.key ?? "membership_id";
      const key = last[keyField];
      if (typeof key !== "string") return { next: null, complete: false };
      return { next: { kind: "latest_per_key", key }, complete: false };
    }
    default:
      return { next: null, complete: true };
  }
}

/**
 * A fair, rotating visit order.
 *
 * When the cycle row budget runs out, whichever sources came last go unread. A fixed order would
 * starve the same ones for ever; rotating by the sweep generation means every source reaches the
 * front eventually. Deterministic, so a cycle is still reproducible.
 */
export function rotate<T>(items: readonly T[], generation: number): T[] {
  if (items.length === 0) return [];
  const offset = ((generation % items.length) + items.length) % items.length;
  return [...items.slice(offset), ...items.slice(0, offset)];
}

/** A running budget across one cycle. */
export class RowBudget {
  private used = 0;
  constructor(private readonly total: number = CYCLE_ROW_BUDGET) {}

  /** How many rows this source may read now — never more than a page, never past the budget. */
  allow(pageSize: number): number {
    return Math.max(0, Math.min(pageSize, this.total - this.used));
  }

  spend(rows: number): void {
    this.used += Math.max(0, rows);
  }

  get spent(): number {
    return this.used;
  }

  get exhausted(): boolean {
    return this.used >= this.total;
  }
}
