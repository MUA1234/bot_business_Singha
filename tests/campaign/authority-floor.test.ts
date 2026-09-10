/**
 * Overnight campaign — regression tests for D-004: the model used to set its own authority.
 *
 * `planFromObservation` copied `requiredAuthority` straight out of the model's JSON, and derived
 * "needs a human" from it. The model reads untrusted text, so that made the recorded authority of
 * a case attacker-influenceable, with only a sentence in the prompt asking the model to be careful.
 * The constitution's order is schema validation → DETERMINISTIC authority rules → permission →
 * audit; a prompt instruction is not the deterministic step.
 *
 * `authorityFloor` now computes a floor from the observation's own structured fields and the plan
 * takes the HIGHER of (model claim, floor).
 *
 * Honest note on what these tests are: `authorityFloor` does not exist before the fix, so this file
 * cannot LINK against the pre-fix tree — that is a module error, not behavioural discrimination.
 * The assertions that genuinely discriminate are the ones on `planFromObservation`, a pre-existing
 * export whose output changes: pre-fix it returned the model's claim verbatim, so each
 * "forces at least …" case below returned `automatic` / `needsApproval: false`.
 *
 * Known limitation of this control, recorded rather than hidden: the floor is computed from OTHER
 * fields of the SAME model output. It narrows the model's freedom from one field to three; it does
 * not make the decision independent of the model. A company-scoped authority engine
 * (`authority_rules` / `authority_limits`, per docs/AUTHORITY_MATRIX.md) is the real answer and is
 * an owner-gated follow-up, not something this campaign invented for itself.
 */
import { describe, it, expect } from "vitest";
import { planFromObservation, authorityFloor } from "@/management/ai-manager/pipeline";
import { ManagementObservation } from "@/schemas/management";

/** A minimal valid observation; callers override only what the case is about. */
function obs(over: Partial<ManagementObservation> = {}): ManagementObservation {
  return ManagementObservation.parse({
    sourceEventId: "evt-1",
    scope: { companyId: "co-1" },
    confidence: 0.8,
    requiredAuthority: "automatic",
    detectedTasks: [{ title: "Synthetic follow-up" }],
    ...over,
  });
}

describe("campaign D-004 — a model cannot declare a material matter routine", () => {
  it("financial impact forces at least specialist approval, even when the model says automatic", () => {
    const plan = planFromObservation(obs({ impact: { financial: "LKR 2,400,000 to a supplier" } }));
    expect(plan.requiredAuthority).toBe("specialist_approval");
    expect(plan.needsApproval).toBe(true);
  });

  it("legal impact forces at least specialist approval", () => {
    const plan = planFromObservation(obs({ impact: { legal: "contract renewal exposure" } }));
    expect(plan.requiredAuthority).toBe("specialist_approval");
    expect(plan.needsApproval).toBe(true);
  });

  it("safety impact forces at least specialist approval", () => {
    const plan = planFromObservation(obs({ impact: { safety: "guard removed from a machine" } }));
    expect(plan.requiredAuthority).toBe("specialist_approval");
  });

  it("operational or customer impact forces at least manager approval", () => {
    expect(planFromObservation(obs({ impact: { operational: "delivery delayed" } })).requiredAuthority).toBe("manager_approval");
    expect(planFromObservation(obs({ impact: { customer: "customer is unhappy" } })).requiredAuthority).toBe("manager_approval");
  });

  it("a placeholder impact value does NOT escalate (over-escalation is not safety)", () => {
    // The impact fields are optional free text and a model routinely fills them with a placeholder
    // rather than omitting them. Raw truthiness would escalate on "none" — making the floor a
    // permanent alarm and drowning the signal it exists to raise.
    for (const v of ["none", "None", "N/A", "nil", "no", "-", " "]) {
      const plan = planFromObservation(obs({ impact: { financial: v } }));
      expect(plan.requiredAuthority).toBe("automatic");
      expect(plan.needsApproval).toBe(false);
    }
  });

  it("a merely-named person does not escalate on its own", () => {
    // Deliberately NOT a floor rule: the prompt asks the model to list every name it sees, so
    // "Nimal called about the delivery" would escalate nearly every real observation.
    const plan = planFromObservation(
      obs({ involved: { people: ["A synthetic employee"], customers: [], suppliers: [], vehicles: [], assets: [] } }),
    );
    expect(plan.requiredAuthority).toBe("automatic");
  });

  it("a low-confidence reading is never routine", () => {
    const plan = planFromObservation(obs({ confidence: 0.1 }));
    expect(plan.requiredAuthority).toBe("manager_approval");
    expect(plan.needsApproval).toBe(true);
  });

  it("the injection case: untrusted text cannot talk the model down to automatic", () => {
    // The scenario the fix exists for — a message about a supplier bank change and a large payment,
    // where the model (steered or simply wrong) returns the most permissive level it can express.
    const plan = planFromObservation(
      obs({
        requiredAuthority: "automatic",
        confidence: 0.97,
        impact: { financial: "LKR 2.4M payment to a changed bank account" },
        suggestedActions: ["Pay the supplier today"],
      }),
    );
    expect(plan.requiredAuthority).toBe("specialist_approval");
    expect(plan.needsApproval).toBe(true);
  });
});

describe("campaign D-004 — the floor raises, never lowers", () => {
  it("a model asking for MORE authority than the floor is respected", () => {
    const plan = planFromObservation(obs({ requiredAuthority: "owner_approval", impact: { operational: "minor" } }));
    expect(plan.requiredAuthority).toBe("owner_approval"); // not reduced to the manager floor
  });

  it("a genuinely routine observation stays automatic (no false escalation)", () => {
    const plan = planFromObservation(obs({ requiredAuthority: "automatic", confidence: 0.9 }));
    expect(plan.requiredAuthority).toBe("automatic");
    expect(plan.needsApproval).toBe(false);
  });

  it("the floor itself is pure and content-derived", () => {
    expect(authorityFloor(obs())).toBe("automatic");
    expect(authorityFloor(obs({ impact: { financial: "x" } }))).toBe("specialist_approval");
  });
});
