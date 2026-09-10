/**
 * Management-item lifecycle — behavioural tests (R1 checkpoint 2, KRN-001).
 *
 * Behavioural only: every assertion calls the lifecycle and checks what it DOES. Nothing
 * here reads source text (owner safeguard 5).
 */
import { describe, it, expect } from "vitest";
import {
  ITEM_STATES,
  TERMINAL_STATES,
  allowedTransitions,
  canTransition,
  isTerminal,
  assertTransition,
  requiresReason,
  requiresEvidence,
  outcomeFor,
  IllegalTransitionError,
  type ItemState,
} from "@/kernel/lifecycle";

/** Evidence + reason supplied, so only the transition itself is under test. */
const OK = { evidenceCount: 3, reason: "because", authority: "automatic" as const, actionIsAutomaticSafe: true };

describe("lifecycle — the 16 states", () => {
  it("declares exactly the 16 states, including needs_routing from owner decision R1-D-3", () => {
    expect(ITEM_STATES).toHaveLength(16);
    expect(ITEM_STATES).toContain("needs_routing");
    expect(new Set(ITEM_STATES).size).toBe(16); // no duplicates
  });

  it("every state has a transition entry, so no state is unreachable dead configuration", () => {
    for (const s of ITEM_STATES) {
      expect(Array.isArray(allowedTransitions(s))).toBe(true);
    }
  });

  it("every transition target is itself a declared state", () => {
    for (const s of ITEM_STATES) {
      for (const t of allowedTransitions(s)) {
        expect(ITEM_STATES).toContain(t);
      }
    }
  });

  it("terminal states allow nothing to follow", () => {
    for (const s of TERMINAL_STATES) {
      expect(isTerminal(s)).toBe(true);
      expect(allowedTransitions(s)).toEqual([]);
    }
  });

  it("every non-terminal state can reach a terminal state, so no item can be stranded forever", () => {
    // Breadth-first from each non-terminal state.
    for (const start of ITEM_STATES.filter((s) => !isTerminal(s))) {
      const seen = new Set<ItemState>([start]);
      const queue: ItemState[] = [start];
      let reachedTerminal = false;
      while (queue.length) {
        const cur = queue.shift()!;
        if (isTerminal(cur)) {
          reachedTerminal = true;
          break;
        }
        for (const n of allowedTransitions(cur)) {
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      expect(reachedTerminal, `"${start}" cannot reach any terminal state`).toBe(true);
    }
  });
});

describe("lifecycle — the happy path", () => {
  it("walks observed → verified through every intermediate state", () => {
    const path: ItemState[] = [
      "observed", "understood", "prioritised", "recommended",
      "awaiting_approval", "approved", "assigned", "monitoring", "verifying", "verified",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      expect(canTransition(path[i]!, path[i + 1]!), `${path[i]} -> ${path[i + 1]}`).toBe(true);
      expect(() => assertTransition(path[i]!, path[i + 1]!, OK)).not.toThrow();
    }
  });

  it("re-observation that still fails reopens instead of verifying", () => {
    expect(canTransition("verifying", "reopened")).toBe(true);
    expect(() => assertTransition("verifying", "reopened", OK)).not.toThrow();
  });

  it("a reopened item can be worked again", () => {
    expect(canTransition("reopened", "assigned")).toBe(true);
    expect(canTransition("reopened", "prioritised")).toBe(true);
  });
});

describe("lifecycle — illegal transitions THROW", () => {
  it("refuses a jump from observed straight to assigned", () => {
    expect(() => assertTransition("observed", "assigned", OK)).toThrow(IllegalTransitionError);
  });

  it("refuses skipping approval by going prioritised → approved", () => {
    expect(() => assertTransition("prioritised", "approved", OK)).toThrow(IllegalTransitionError);
  });

  it("refuses any transition out of a terminal state", () => {
    for (const s of TERMINAL_STATES) {
      expect(() => assertTransition(s, "assigned", OK)).toThrow(IllegalTransitionError);
    }
  });

  it("refuses verified → reopened (verified is final; re-work starts a new observation)", () => {
    expect(canTransition("verified", "reopened")).toBe(false);
    expect(() => assertTransition("verified", "reopened", OK)).toThrow(IllegalTransitionError);
  });

  it("names the allowed transitions in the error, so the failure is diagnosable", () => {
    try {
      assertTransition("observed", "verified", OK);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain("understood");
    }
  });

  it("exhaustively rejects every unlisted state pair", () => {
    let rejected = 0;
    for (const from of ITEM_STATES) {
      for (const to of ITEM_STATES) {
        if (allowedTransitions(from).includes(to)) continue;
        expect(() => assertTransition(from, to, OK)).toThrow(IllegalTransitionError);
        rejected++;
      }
    }
    expect(rejected).toBeGreaterThan(200); // 16x16 minus the legal edges
  });
});

describe("lifecycle — approval may not be skipped (owner decision D-9)", () => {
  it("allows recommended → assigned ONLY at automatic authority with a safe registered action", () => {
    expect(() =>
      assertTransition("recommended", "assigned", { ...OK, authority: "automatic", actionIsAutomaticSafe: true }),
    ).not.toThrow();
  });

  it("refuses recommended → assigned above automatic authority", () => {
    for (const authority of ["policy_controlled", "manager_approval", "specialist_approval", "owner_approval"] as const) {
      expect(() =>
        assertTransition("recommended", "assigned", { ...OK, authority, actionIsAutomaticSafe: true }),
      ).toThrow(/authority/i);
    }
  });

  it("refuses recommended → assigned when the action is not catalogue-safe, even at automatic authority", () => {
    expect(() =>
      assertTransition("recommended", "assigned", { ...OK, authority: "automatic", actionIsAutomaticSafe: false }),
    ).toThrow(/automatic/i);
  });

  it("always permits the approval route regardless of authority", () => {
    expect(() => assertTransition("recommended", "awaiting_approval", { ...OK, authority: "owner_approval" })).not.toThrow();
  });
});

describe("lifecycle — a reason is required where it is the learning signal", () => {
  it.each(["dismissed", "rejected"] as const)("requires a reason to enter %s", (state) => {
    expect(requiresReason(state)).toBe(true);
  });

  it("refuses a dismissal with no reason", () => {
    expect(() => assertTransition("observed", "dismissed", { evidenceCount: 1, reason: "" })).toThrow(/reason/i);
  });

  it("refuses a dismissal whose reason is only whitespace", () => {
    expect(() => assertTransition("observed", "dismissed", { evidenceCount: 1, reason: "   " })).toThrow(/reason/i);
  });

  it("accepts a dismissal with a real reason", () => {
    expect(() => assertTransition("observed", "dismissed", { evidenceCount: 1, reason: "duplicate of INV-88" })).not.toThrow();
  });

  it("refuses a rejection with no reason", () => {
    expect(() => assertTransition("awaiting_approval", "rejected", { evidenceCount: 1 })).toThrow(/reason/i);
  });
});

describe("lifecycle — zero-evidence prohibition", () => {
  it("marks the downstream states as evidence-requiring", () => {
    for (const s of ["recommended", "awaiting_approval", "approved", "needs_routing", "assigned", "monitoring", "verifying", "verified"] as const) {
      expect(requiresEvidence(s)).toBe(true);
    }
  });

  it("refuses recommendation with zero evidence", () => {
    expect(() => assertTransition("prioritised", "recommended", { evidenceCount: 0 })).toThrow(/evidence/i);
  });

  it("permits recommendation with at least one evidence reference", () => {
    expect(() => assertTransition("prioritised", "recommended", { evidenceCount: 1 })).not.toThrow();
  });

  it("does not require evidence to dismiss — an item can be noise", () => {
    expect(() => assertTransition("observed", "dismissed", { evidenceCount: 0, reason: "not a real condition" })).not.toThrow();
  });
});

describe("lifecycle — needs_routing (owner decision R1-D-3)", () => {
  it("is reachable when a recommendation has no assignee", () => {
    expect(canTransition("recommended", "needs_routing")).toBe(true);
    expect(canTransition("approved", "needs_routing")).toBe(true);
  });

  it("can be routed to a person, or escalated by review policy — but never silently dropped", () => {
    expect(allowedTransitions("needs_routing")).toEqual(
      expect.arrayContaining(["assigned", "escalated"]),
    );
  });

  it("an escalated item can return to routing rather than sticking to one owner", () => {
    expect(canTransition("escalated", "needs_routing")).toBe(true);
  });

  it("is not terminal — unrouted work always remains actionable", () => {
    expect(isTerminal("needs_routing")).toBe(false);
  });
});

describe("lifecycle — terminal outcomes", () => {
  it.each([
    ["verified", "resolved"],
    ["rejected", "rejected"],
    ["dismissed", "dismissed"],
    ["expired", "expired"],
  ] as const)("%s implies outcome %s", (state, outcome) => {
    expect(outcomeFor(state)).toBe(outcome);
  });

  it("non-terminal states imply no outcome", () => {
    for (const s of ITEM_STATES.filter((x) => !isTerminal(x))) {
      expect(outcomeFor(s)).toBeNull();
    }
  });
});
