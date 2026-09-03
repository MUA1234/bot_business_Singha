/**
 * R2S-P — the cursor and budget logic, tested without a database.
 *
 * The live campaign proves records cannot hide from a real sweep. These are the properties that
 * make that possible, isolated so a regression names the rule it broke rather than surfacing as
 * "a row went missing" three layers up.
 */
import { describe, expect, it } from "vitest";
import {
  parseCursor, nextCursorFrom, rotate, RowBudget, CursorRejected, validateCursorEnvelope,
  OVERLAP_MS, PAGE_SIZE, CYCLE_ROW_BUDGET, PERMITTED_CURSOR_KEYS,
} from "@/kernel/pagination";

describe("a cursor holds POSITION and nothing else", () => {
  it("accepts each valid shape", () => {
    expect(parseCursor({ kind: "sweep_by_id", id: "a" })).toEqual({ kind: "sweep_by_id", id: "a" });
    expect(parseCursor({ kind: "latest_per_key", key: "m1" })).toEqual({ kind: "latest_per_key", key: "m1" });
    expect(parseCursor({ kind: "keyset_updated", updatedAt: "2026-09-02T00:00:00.000Z", id: "a" }))
      .toEqual({ kind: "keyset_updated", updatedAt: "2026-09-02T00:00:00.000Z", id: "a" });
    expect(parseCursor(null)).toBeNull();
  });

  it("REFUSES any key that is not a position field", () => {
    // Cursor state is a tempting place to park context. It must not become one.
    for (const key of ["body", "amount", "customerName", "token", "secret", "evidence", "salary"]) {
      expect(() => parseCursor({ kind: "sweep_by_id", id: "a", [key]: "x" }), key)
        .toThrow(CursorRejected);
    }
  });

  it("names the permitted fields explicitly, so widening them is a deliberate change", () => {
    // This list is the whole guard. It failed when `fence` was added, which is the gate doing
    // its job — widening what a cursor may carry has to be argued for, not absorbed.
    //
    // `fence` earns its place on the same terms as the others: it is a POSITION — the instant a
    // reconciliation generation began — and it is the reason that generation can finish at all.
    // It carries no customer content, no amount, no employee data, no evidence and no secret,
    // and draft unit 019 additionally requires it to parse as a timestamp at the database, so
    // it cannot become a free-text field wearing a position's name.
    expect([...PERMITTED_CURSOR_KEYS].sort()).toEqual(["fence", "id", "key", "kind", "updatedAt"]);
  });

  it("REFUSES a fence that is not a timestamp", () => {
    // The allowlist says WHICH keys; this says the new one cannot smuggle content.
    expect(() => parseCursor({ kind: "sweep_by_id", id: "a", fence: "tomorrow-ish" }))
      .toThrow(CursorRejected);
    expect(() => parseCursor({ kind: "sweep_by_id", id: "a", fence: "a customer said hello" }))
      .toThrow(/unreadable fence/);
    expect(parseCursor({ kind: "sweep_by_id", id: "a", fence: "2026-09-03T00:00:00.000Z" }))
      .toEqual({ kind: "sweep_by_id", id: "a", fence: "2026-09-03T00:00:00.000Z" });
  });

  it("REFUSES a malformed cursor rather than repositioning a sweep", () => {
    // Silently accepting a bad cursor is worse than failing: repositioning to the end would make
    // a whole domain look empty, which reads exactly like "nothing needs attention".
    expect(() => parseCursor({ kind: "teleport" })).toThrow(/unknown cursor kind/);
    expect(() => parseCursor({ kind: "sweep_by_id" })).toThrow(/needs a string id/);
    expect(() => parseCursor({ kind: "keyset_updated", updatedAt: "yesterday", id: "a" }))
      .toThrow(/unreadable updatedAt/);
    expect(() => parseCursor("string")).toThrow(/must be an object/);
    expect(() => parseCursor(42)).toThrow(/must be an object/);
  });
});

describe("cursor validation accepts what the DATABASE actually writes", () => {
  // The shapes PostgreSQL returns for a timestamptz, verbatim. Rejecting any of these makes
  // every stored position look corrupt, and a sweep that resets on every cycle never
  // completes, never settles and never licenses resolution.
  const REAL = [
    "2026-09-03 08:12:34.123456+00",   // node-pg / PostgreSQL text output — a BARE hour
    "2026-09-03 08:12:34+00",          // no fractional seconds
    "2026-09-03T08:12:34.123456+00:00", // PostgREST / supabase-js
    "2026-09-03T08:12:34.123Z",         // JavaScript toISOString
    "2026-09-03T08:12:34+05:30",        // a non-UTC offset
    "2026-09-03 08:12:34",              // no offset at all
  ];

  it("accepts every real timestamptz rendering", () => {
    for (const updatedAt of REAL) {
      expect(
        validateCursorEnvelope({ kind: "keyset_updated", updatedAt, id: "" }, "keyset_updated"),
        updatedAt,
      ).toEqual({ ok: true });
    }
  });

  it("still refuses what PostgreSQL would refuse", () => {
    for (const updatedAt of ["March 3 2026", "yesterday", "2026-13-45 99:99:99", ""]) {
      expect(
        validateCursorEnvelope({ kind: "keyset_updated", updatedAt, id: "" }, "keyset_updated").ok,
        updatedAt,
      ).toBe(false);
    }
    // Date.parse accepts this one, which is why Date.parse alone cannot be the check.
    expect(Number.isNaN(Date.parse("March 3 2026"))).toBe(false);
  });
});

describe("a compound cursor must be able to ADVANCE through a tie group", () => {
  // R2S-P-F-001. `updated_at` is not unique: one bulk insert gives hundreds of rows a single
  // timestamp. The original bound was "updated_at >= cursor" with the cursor rewound by the
  // overlap window, so every page re-read the same first rows and the sweep never advanced —
  // 499 seeded tasks yielded exactly 200 observed, for ever, while still reporting hasMore.
  //
  // The loader now splits the compound comparison into two ordinary filters (drain the tie
  // group by id, then step past the timestamp). These are the arithmetic properties that
  // makes that safe; the live campaign proves the queries themselves.

  const tie = (n: number, at: string) => Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(3, "0")}`, updated_at: at,
  }));

  it("carries BOTH halves forward when a full page shares ONE timestamp", () => {
    const at = "2026-09-02T12:00:00.000Z";
    const { next, complete } = nextCursorFrom("keyset_updated", tie(200, at), 200);
    // Not complete, and the id half is what distinguishes the next page from this one.
    expect(complete).toBe(false);
    expect(next).toEqual({ kind: "keyset_updated", updatedAt: at, id: "id-199" });
  });

  it("the cursor STRICTLY increases across consecutive tie pages", () => {
    // The property that guarantees termination: page N+1 starts after page N ends, so a tie
    // group of any size is drained in a finite number of pages.
    const at = "2026-09-02T12:00:00.000Z";
    const first = nextCursorFrom("keyset_updated", tie(200, at), 200).next as { id: string };
    const secondPage = tie(400, at).slice(200);
    const second = nextCursorFrom("keyset_updated", secondPage, 200).next as { id: string };
    expect(second.id > first.id).toBe(true);
  });

  it("preserves a MICROSECOND timestamp verbatim", () => {
    // R2S-P-F-002. PostgreSQL stores microseconds and supabase-js returns all six digits.
    // Rounding the cursor to millisecond precision made `updated_at = cursor` match nothing,
    // so the tie group was never drained and the sweep re-read its way to a standstill —
    // 499 seeded rows, 212 ever observed. The boundary must be carried EXACTLY as read.
    const exact = "2026-09-02T21:43:22.103456+00:00";
    const rows = Array.from({ length: 4 }, (_, i) => ({ id: `id-${i}`, updated_at: exact }));
    const { next } = nextCursorFrom("keyset_updated", rows, 4);
    expect((next as { updatedAt: string }).updatedAt).toBe(exact);
  });

  it("the overlap is a bounded LOOK-BACK, never a rewind of the cursor", () => {
    // A minute is re-read to recover a late writer. The value matters only as a window size;
    // it is applied to a separate non-advancing query, so it can no longer stall a sweep.
    expect(OVERLAP_MS).toBe(60_000);
  });
});

describe("advancing to the next page", () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({
    id: `id-${String(i).padStart(3, "0")}`,
    updated_at: `2026-09-0${(i % 9) + 1}T00:00:00.000Z`,
    membership_id: `m-${String(i).padStart(3, "0")}`,
  }));

  it("a SHORT page means the source is exhausted and the sweep wraps", () => {
    const { next, complete } = nextCursorFrom("sweep_by_id", rows(5), 10);
    expect(complete).toBe(true);
    expect(next).toBeNull();
  });

  it("a FULL page continues from the last row", () => {
    const { next, complete } = nextCursorFrom("sweep_by_id", rows(10), 10);
    expect(complete).toBe(false);
    expect(next).toEqual({ kind: "sweep_by_id", id: "id-009" });
  });

  it("a keyset_updated page carries BOTH halves of the boundary", () => {
    const { next } = nextCursorFrom("keyset_updated", rows(10), 10);
    expect(next).toMatchObject({ kind: "keyset_updated", id: "id-009" });
    expect((next as { updatedAt: string }).updatedAt).toBeTruthy();
  });

  it("STOPS rather than guessing when the boundary cannot be built", () => {
    // Advancing on a guess would skip every row after the unusable one, permanently.
    const bad = [{ id: 42 as unknown as string }];
    const { next, complete } = nextCursorFrom("sweep_by_id", bad, 1);
    expect(next).toBeNull();
    expect(complete).toBe(false);
  });

  it("an EMPTY page is complete", () => {
    expect(nextCursorFrom("sweep_by_id", [], 10)).toEqual({ next: null, complete: true });
  });
});

describe("fair rotation stops a source starving for ever", () => {
  const sources = ["a", "b", "c", "d"];

  it("moves the front of the queue with each generation", () => {
    expect(rotate(sources, 0)).toEqual(["a", "b", "c", "d"]);
    expect(rotate(sources, 1)).toEqual(["b", "c", "d", "a"]);
    expect(rotate(sources, 3)).toEqual(["d", "a", "b", "c"]);
  });

  it("every source reaches the front within one full turn", () => {
    const firsts = new Set(sources.map((_, g) => rotate(sources, g)[0]));
    expect(firsts).toEqual(new Set(sources));
  });

  it("is deterministic, so a cycle stays reproducible", () => {
    expect(rotate(sources, 7)).toEqual(rotate(sources, 7));
  });

  it("handles a negative or huge generation without throwing", () => {
    expect(rotate(sources, -1)).toHaveLength(4);
    expect(rotate(sources, 1_000_003)).toHaveLength(4);
    expect(rotate([], 5)).toEqual([]);
  });
});

describe("the cycle row budget", () => {
  it("never allows more than a page at a time", () => {
    expect(new RowBudget(10_000).allow(PAGE_SIZE)).toBe(PAGE_SIZE);
  });

  it("shrinks the allowance as the budget is spent, then reaches zero", () => {
    const b = new RowBudget(500);
    expect(b.allow(PAGE_SIZE)).toBe(200);
    b.spend(200);
    expect(b.allow(PAGE_SIZE)).toBe(200);
    b.spend(200);
    // 400 of 500 spent: only the remainder is offered, never a full page.
    expect(b.allow(PAGE_SIZE)).toBe(100);
    b.spend(100);
    expect(b.allow(PAGE_SIZE)).toBe(0);
    expect(b.exhausted).toBe(true);
  });

  it("never returns a negative allowance, however far it is overspent", () => {
    const b = new RowBudget(100);
    b.spend(1_000);
    expect(b.allow(PAGE_SIZE)).toBe(0);
    expect(b.exhausted).toBe(true);
  });

  it("ignores a negative spend rather than refunding budget", () => {
    const b = new RowBudget(100);
    b.spend(-50);
    expect(b.spent).toBe(0);
  });

  it("defaults to the documented whole-cycle budget", () => {
    expect(new RowBudget().allow(CYCLE_ROW_BUDGET + 1)).toBe(CYCLE_ROW_BUDGET);
  });
});
