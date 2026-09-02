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
export const OVERLAP_MS = 60_000;

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
  | { kind: "sweep_by_id"; id: string }
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
  "kind", "updatedAt", "id", "key",
]);

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
    case "sweep_by_id":
      if (typeof o.id !== "string") throw new CursorRejected("sweep_by_id needs a string id");
      return { kind: "sweep_by_id", id: o.id };
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
