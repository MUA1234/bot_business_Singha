/**
 * The cockpit's management summary — extracted so its BEHAVIOUR can be tested (R2F-F-001).
 *
 * It lived inline in `CommandCentrePanel`, which is an async server component that opens a Supabase
 * client at module scope. That made it unrenderable in a unit test, so the tests asserted the
 * presence of strings in the source instead — and a mutation that disabled the whole
 * unavailable-branch condition passed all eleven of them. Asserting that a file CONTAINS
 * `"Management data unavailable"` says nothing about when it is shown.
 *
 * So the decision is a pure function over the rows and the failed-source list, and the tests ask it
 * questions instead of reading it.
 */

/** The three states this section can be in, and they are not interchangeable. */
export type ManagementSummary =
  /** The read failed. NOT an empty queue — an unread one. */
  | { readonly kind: "unavailable" }
  /** Read successfully; genuinely nothing open. */
  | { readonly kind: "empty" }
  | {
      readonly kind: "open";
      readonly total: number;
      /** Items in a state where the system has done what it can and cannot proceed alone. */
      readonly waitingOnAPerson: number;
      /** Descending by count, so the busiest department reads first. */
      readonly byDepartment: ReadonlyArray<readonly [string, number]>;
    };

/**
 * States in which the system is waiting on a human.
 *
 * Derived from the STATE, never from a guess about who holds what authority: the cockpit does not
 * know the viewer's permissions and must not imply that it does.
 */
const AWAITING_HUMAN = new Set([
  "recommended",
  "awaiting_approval",
  "needs_routing",
  "escalated",
]);

export function summariseManagement(
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined,
  failedSources: readonly string[],
): ManagementSummary {
  // Checked FIRST. A failed read yields an empty array, so testing the rows before the failure
  // would report "nothing open" — the reassuring version of "we could not look".
  if (failedSources.includes("management_items")) return { kind: "unavailable" };

  const open = rows ?? [];
  if (open.length === 0) return { kind: "empty" };

  const byDepartment = [
    ...open.reduce((m, i) => {
      const d = String(i.department ?? "unknown");
      return m.set(d, (m.get(d) ?? 0) + 1);
    }, new Map<string, number>()),
  ].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));

  return {
    kind: "open",
    total: open.length,
    waitingOnAPerson: open.filter((i) => AWAITING_HUMAN.has(String(i.state))).length,
    byDepartment,
  };
}
