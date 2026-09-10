/**
 * Outcome verification by re-observation (roadmap R5, R2F-F-004).
 *
 * The rule under test is that three things stay apart: an action was executed, work was claimed
 * complete, and the original business condition is verified resolved. Only the third may be called
 * success, and only it may feed positive learning.
 *
 * The operations rule re-runs the REAL detector (`detectTaskExceptions`) rather than a copy of its
 * logic, so verification cannot drift from detection and start disagreeing about what the problem
 * was. These tests therefore exercise the real condition, not a restatement of it.
 */
import { describe, it, expect } from "vitest";
import { verifyOutcome, type VerificationInput } from "@/kernel/verification/verify";
import {
  feedsPositiveLearning,
  isNeutralForPeople,
  type ItemUnderVerification,
  type VerificationOutcome,
} from "@/kernel/verification/contract";
import { ruleFor, verifiableDomains } from "@/kernel/verification/rules";
import type { TaskUnderVerification } from "@/kernel/verification/rules";

const CO = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-06T09:00:00.000Z");
const CLAIMED = new Date("2026-09-06T08:00:00.000Z");
const OBSERVED = new Date("2026-09-06T08:30:00.000Z");

const task = (over: Partial<TaskUnderVerification> = {}): TaskUnderVerification => ({
  id: "task-1",
  title: "Chase the delivery",
  status: "in_progress",
  dueDate: "2026-09-01",
  lastCheckInAt: NOW.toISOString(),
  estimateHours: 4,
  requiresEvidence: false,
  verifiedEvidenceCount: 0,
  ...over,
});

const item = (over: Partial<ItemUnderVerification> = {}): ItemUnderVerification => ({
  id: "item-1",
  companyId: CO,
  department: "operations",
  kind: "overdue",
  subjectTable: "tasks",
  subjectId: "task-1",
  state: "verifying",
  evidenceGeneration: "gen-1",
  claimedAt: CLAIMED,
  ...over,
});

const input = (over: Partial<VerificationInput> = {}): VerificationInput => ({
  item: item(),
  companyId: CO,
  observed: { subjectTable: "tasks", subjectId: "task-1" },
  evidenceGenerationNow: "gen-1",
  sweep: { complete: true, generation: "gen-1", interrupted: false, observedAt: OBSERVED },
  read: { ok: true, row: task() },
  now: NOW,
  ...over,
});

describe("the three facts stay apart", () => {
  it("only `verified_resolved` feeds positive learning", () => {
    const all: VerificationOutcome[] = [
      "verified_resolved", "condition_persists", "condition_worsened",
      "contradicted", "unavailable", "pending_clean_observation",
    ];
    expect(all.filter(feedsPositiveLearning)).toEqual(["verified_resolved"]);
  });

  it("persisting, unavailable and pending outcomes are NEUTRAL for people", () => {
    // Approved leave, a missing record and a source failure are facts about the world or about
    // this system. Letting them count against a person is how a management tool becomes a
    // surveillance tool.
    for (const o of ["condition_persists", "unavailable", "pending_clean_observation"] as const) {
      expect(isNeutralForPeople(o), o).toBe(true);
    }
    expect(isNeutralForPeople("verified_resolved")).toBe(false);
  });
});

describe("a genuine resolution", () => {
  it("verifies when the originating task reached a terminal status and needed no evidence", () => {
    const out = verifyOutcome(input({ read: { ok: true, row: task({ status: "completed" }) } }));
    expect(out.outcome).toBe("verified_resolved");
    expect(out.transitionTo).toBe("verified");
  });

  it("verifies a terminal task whose required evidence WAS verified", () => {
    const out = verifyOutcome(
      input({
        read: {
          ok: true,
          row: task({ status: "completed", requiresEvidence: true, verifiedEvidenceCount: 2 }),
        },
      }),
    );
    expect(out.outcome).toBe("verified_resolved");
  });

  it("verifies when the condition itself is no longer raised", () => {
    // Was overdue; the due date has moved into the future and no other exception applies.
    const out = verifyOutcome(
      input({
        read: { ok: true, row: task({ dueDate: "2026-12-01", lastCheckInAt: NOW.toISOString() }) },
      }),
    );
    expect(out.outcome).toBe("verified_resolved");
    expect(out.transitionTo).toBe("verified");
  });
});

describe("a completion CLAIM is not a verification", () => {
  it("a task closed as complete that REQUIRED evidence, with none verified, is contradicted", () => {
    // This is "a user clicked complete", which the contract says is never proof. The record's own
    // requirement disagrees with the claim, so a person has to look — it is not resolved and it is
    // not simply persisting either.
    const out = verifyOutcome(
      input({
        read: {
          ok: true,
          row: task({ status: "completed", requiresEvidence: true, verifiedEvidenceCount: 0 }),
        },
      }),
    );
    expect(out.outcome).toBe("contradicted");
    expect(out.transitionTo).toBe("reopened");
  });

  it("unverified evidence does not count — it must have been verified by someone", () => {
    // `verifiedEvidenceCount` counts rows a human verified. Self-attached evidence is a claim
    // about a claim.
    const out = verifyOutcome(
      input({
        read: {
          ok: true,
          row: task({ status: "cancelled", requiresEvidence: true, verifiedEvidenceCount: 0 }),
        },
      }),
    );
    expect(out.outcome).toBe("contradicted");
  });
});

describe("the condition is still there", () => {
  it("reopens when the SAME condition persists", () => {
    const out = verifyOutcome(input()); // still overdue
    expect(out.outcome).toBe("condition_persists");
    expect(out.transitionTo).toBe("reopened");
  });

  it("a task CLAIMED complete but still live and still overdue does not verify", () => {
    // The claim is what put the item into `verifying`. The read is what decides.
    const out = verifyOutcome(input({ item: item({ state: "verifying" }) }));
    expect(out.outcome).toBe("condition_persists");
  });

  it("reports WORSENED when the original is gone but something more severe replaced it", () => {
    // Was `due_soon` (warn); now escalated (critical). Reporting that as resolved would be the
    // most misleading answer available.
    const out = verifyOutcome(
      input({
        item: item({ kind: "due_soon" }),
        read: { ok: true, row: task({ status: "escalated", dueDate: "2026-12-01" }) },
      }),
    );
    expect(out.outcome).toBe("condition_worsened");
    expect(out.transitionTo).toBe("reopened");
  });
});

describe("absence, failure and ambiguity never read as success", () => {
  it("a FAILED read is unavailable, not resolved", () => {
    const out = verifyOutcome(input({ read: { ok: false, reason: "connection reset" } }));
    expect(out.outcome).toBe("unavailable");
    expect(out.transitionTo).toBeNull();
  });

  it("a DELETED originating record is unavailable — deletion is ambiguous", () => {
    // A completed task and a deleted one look identical from outside. Refusing is the only
    // truthful answer.
    const out = verifyOutcome(input({ read: { ok: true, row: null } }));
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("ambiguous");
    expect(out.transitionTo).toBeNull();
  });

  it("an INCOMPLETE sweep yields pending, never resolved", () => {
    const out = verifyOutcome(
      input({
        sweep: { complete: false, generation: "gen-1", interrupted: false, observedAt: OBSERVED },
      }),
    );
    expect(out.outcome).toBe("pending_clean_observation");
  });

  it("a RESET or ABANDONED generation yields pending", () => {
    const out = verifyOutcome(
      input({
        sweep: { complete: true, generation: "gen-1", interrupted: true, observedAt: OBSERVED },
      }),
    );
    expect(out.outcome).toBe("pending_clean_observation");
    expect(out.detail).toContain("reset or abandoned");
  });
});

describe("the observation must be about the right thing, at the right time", () => {
  it("refuses a read taken BEFORE the completion claim", () => {
    // A read from before the claim describes the world that prompted the work.
    const out = verifyOutcome(
      input({
        sweep: {
          complete: true, generation: "gen-1", interrupted: false,
          observedAt: new Date(CLAIMED.getTime() - 60_000),
        },
      }),
    );
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("not later than");
  });

  it("refuses a read of a DIFFERENT record", () => {
    for (const observed of [
      { subjectTable: "tasks", subjectId: "task-2" },
      { subjectTable: "customer_invoices", subjectId: "task-1" },
    ]) {
      const out = verifyOutcome(input({ observed }));
      expect(out.outcome, JSON.stringify(observed)).toBe("unavailable");
      expect(out.detail).toContain("different record");
    }
  });

  it("refuses a CROSS-COMPANY item", () => {
    const out = verifyOutcome(input({ companyId: "22222222-2222-4222-8222-222222222222" }));
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("different company");
  });

  it("refuses when the evidence generation moved on", () => {
    const out = verifyOutcome(input({ evidenceGenerationNow: "gen-9" }));
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("evidence generation changed");
  });

  it("refuses from a state that does not admit verification", () => {
    for (const state of ["observed", "recommended", "approved", "assigned", "verified", "rejected"]) {
      const out = verifyOutcome(input({ item: item({ state }) }));
      expect(out.outcome, state).toBe("unavailable");
      expect(out.transitionTo).toBeNull();
    }
  });
});

describe("domains without a rule say so, rather than guessing", () => {
  it("exactly one domain can verify today", () => {
    expect(verifiableDomains()).toEqual(["operations"]);
  });

  it("every other domain returns unavailable, naming itself", () => {
    for (const department of [
      "finance", "workforce", "crm", "system", "governance", "objectives",
      "marketing", "procurement", "assets", "legal", "providers",
    ] as const) {
      expect(ruleFor(department), department).toBeNull();
      const out = verifyOutcome(input({ item: item({ department }) }));
      expect(out.outcome, department).toBe("unavailable");
      expect(out.detail).toContain(department);
      expect(out.transitionTo).toBeNull();
    }
  });

  it("an unknown department fails closed", () => {
    expect(ruleFor("not_a_domain")).toBeNull();
    expect(ruleFor("constructor")).toBeNull();
  });

  it("a rule refuses an item pointed at a table it does not verify", () => {
    const out = verifyOutcome(
      input({
        item: item({ subjectTable: "customer_invoices" }),
        observed: { subjectTable: "customer_invoices", subjectId: "task-1" },
      }),
    );
    expect(out.outcome).toBe("unavailable");
    expect(out.detail).toContain("verifies tasks");
  });
});

describe("what must never be used as evidence", () => {
  it("`updated_at` is not consulted anywhere in the verification path", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "src/kernel/verification/verify.ts",
      "src/kernel/verification/rules.ts",
      "src/kernel/verification/contract.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(code.includes("updated_at"), `${f} must not read updated_at`).toBe(false);
      expect(code.includes("updatedAt"), `${f} must not read updatedAt`).toBe(false);
    }
  });

  it("an execution having succeeded is not an input to verification at all", async () => {
    const { readFileSync } = await import("node:fs");
    const code = readFileSync("src/kernel/verification/verify.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    for (const forbidden of ["execution", "effectRef", "executed"]) {
      expect(code.includes(forbidden), `verification must not consult ${forbidden}`).toBe(false);
    }
  });
});
