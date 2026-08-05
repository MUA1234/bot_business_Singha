import { describe, it, expect } from "vitest";
import {
  canTransition,
  allowedTransitions,
  isTerminal,
  canComplete,
  assertTransition,
  TASK_STATES,
} from "@/modules/work/task-lifecycle";

describe("task lifecycle (change plan §7.3)", () => {
  it("allows the happy path", () => {
    expect(canTransition("captured", "planned")).toBe(true);
    expect(canTransition("planned", "awaiting_estimate")).toBe(true);
    expect(canTransition("awaiting_estimate", "scheduled")).toBe(true);
    expect(canTransition("scheduled", "in_progress")).toBe(true);
    expect(canTransition("in_progress", "awaiting_evidence")).toBe(true);
    expect(canTransition("awaiting_evidence", "verification")).toBe(true);
    expect(canTransition("verification", "completed")).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("captured", "completed")).toBe(false);
    expect(canTransition("scheduled", "verification")).toBe(false);
    expect(canTransition("completed", "in_progress")).toBe(false); // must reopen first
  });

  it("cancelled is terminal; completed reopens", () => {
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("completed")).toBe(true);
    expect(allowedTransitions("cancelled")).toEqual([]);
    expect(canTransition("completed", "reopened")).toBe(true);
  });

  it("blocks completion without human-verified evidence (Constitution §10)", () => {
    expect(canComplete({ requiresEvidence: false, hasEvidence: false, verifiedByHuman: false })).toBe(true);
    expect(canComplete({ requiresEvidence: true, hasEvidence: false, verifiedByHuman: true })).toBe(false);
    expect(canComplete({ requiresEvidence: true, hasEvidence: true, verifiedByHuman: false })).toBe(false);
    expect(canComplete({ requiresEvidence: true, hasEvidence: true, verifiedByHuman: true })).toBe(true);
  });

  it("assertTransition enforces both structure and the evidence guard", () => {
    expect(assertTransition("captured", "completed").ok).toBe(false);
    expect(assertTransition("verification", "completed").ok).toBe(false); // no ctx
    expect(
      assertTransition("verification", "completed", {
        requiresEvidence: true, hasEvidence: false, verifiedByHuman: true,
      }).ok,
    ).toBe(false);
    expect(
      assertTransition("verification", "completed", {
        requiresEvidence: true, hasEvidence: true, verifiedByHuman: true,
      }).ok,
    ).toBe(true);
  });

  it("every state has a transition entry", () => {
    for (const s of TASK_STATES) expect(Array.isArray(allowedTransitions(s))).toBe(true);
  });
});
