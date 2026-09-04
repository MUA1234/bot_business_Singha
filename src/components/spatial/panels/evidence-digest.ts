import { createHash } from "node:crypto";

/**
 * The evidence generation digest, in TypeScript.
 *
 * ── Why this exists twice ────────────────────────────────────────────────────────────────────
 *
 * The decision RPC computes this digest in SQL (`r1_draft_evidence_digest`) and compares it with
 * the one the reviewer's screen was built from. The screen therefore has to produce the same value,
 * and the queue already loads every item's evidence in one query — so computing it here avoids a
 * per-item round trip.
 *
 * Two implementations of one value is a real risk: if they ever disagree, every decision is refused
 * with `evidence_changed` and the queue becomes unusable in a way that looks like a data problem.
 * That failure is SAFE — it refuses rather than approves — but it is still a failure, so
 * `tests/integration/r2-decision-boundary.test.ts` asserts the two agree on real rows, including
 * the orderings and characters most likely to separate them.
 *
 * The SQL is:
 *
 *     md5(string_agg(source_table || ':' || source_id, '|' order by source_table, source_id))
 *
 * with `'empty'` when there are no rows. Sorting is by the TUPLE, not by the joined string: with
 * `('a','b:c')` and `('a:b','c')` a string sort and a tuple sort disagree, and only one of them is
 * what the database does.
 */
export function evidenceDigest(
  rows: ReadonlyArray<{ sourceTable: string; sourceId: string }>,
): string {
  if (rows.length === 0) return "empty";
  const ordered = [...rows].sort(
    (a, b) =>
      (a.sourceTable < b.sourceTable ? -1 : a.sourceTable > b.sourceTable ? 1 : 0) ||
      (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0),
  );
  const joined = ordered.map((r) => `${r.sourceTable}:${r.sourceId}`).join("|");
  return createHash("md5").update(joined, "utf8").digest("hex");
}
