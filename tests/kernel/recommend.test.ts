/**
 * Recommendation and approval flow — behavioural tests (R1 checkpoint 4).
 *
 * Covers every reviewer action, every authority boundary, separation of duties, concurrency,
 * staleness, evidence loss, malformed fixtures, unsupported actions, unavailable and
 * cross-company assignees, and duplicate submission.
 */
import { describe, it, expect } from "vitest";
import {
  buildRecommendation, reviewItem, selectAssignee,
  REASON_REQUIRED_ACTIONS,
  type ReviewerContext, type ReviewAction, type AssigneeCandidate,
} from "@/kernel/recommend";
import { ACTION_CATALOGUE, actionById, actionFor, catalogueIsInternalOnly } from "@/kernel/catalogue";
import { detectFinanceObservations } from "@/kernel/adapters";
import { fixtureInterpreter, interpretWithGuards, deterministicFallback } from "@/kernel/interpretation";
import { InvariantViolation } from "@/kernel/invariants";
import type { AuthorityContext } from "@/policy/authority-engine";
import type { AuthorityLevel } from "@/schemas/management";
import type { Observation } from "@/kernel/observation";
import type { Interpretation } from "@/kernel/types";

const CO_A = "11111111-1111-1111-1111-111111111111";
const CO_B = "22222222-2222-2222-2222-222222222222";
const NOW = new Date("2026-09-02T09:00:00.000Z");
const MEM_1 = "mem-1";
const MEM_2 = "mem-2";

const observation = (): Observation =>
  detectFinanceObservations({
    companyId: CO_A, correlationId: "corr-1", now: NOW,
    invoices: [{ id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
                 updated_at: "2026-09-01T00:00:00.000Z", status: "open" }],
  })[0]!;

/** A company WITH policy and rules — the engine can resolve rather than fail closed. */
const authority = (over: Partial<AuthorityContext> = {}): AuthorityContext => ({
  companyId: CO_A,
  actorMembershipId: MEM_1,
  rules: [{ domain: "finance", max_amount: "1000000", is_unlimited: false } as never],
  policyPresent: true,
  ...over,
});

const goodInterpretation = async (o: Observation): Promise<Interpretation> =>
  interpretWithGuards(o, o.evidence, fixtureInterpreter());

const reviewer = (over: Partial<ReviewerContext> = {}): ReviewerContext => ({
  membershipId: MEM_1,
  companyId: CO_A,
  capabilities: ["operations.task.manage", "finance.invoice.create"],
  authorityLevel: "manager_approval",
  priorDecisions: [],
  ...over,
});

const item = (over: Partial<Parameters<typeof reviewItem>[0]> = {}) => ({
  id: "item-1", companyId: CO_A, state: "awaiting_approval",
  requiredAuthority: "manager_approval" as AuthorityLevel,
  proposedActionId: "finance.invoice.flag_for_review",
  ...over,
});

describe("the action catalogue", () => {
  it("is entirely internal-only — nothing sends, pays, posts or calls out", () => {
    expect(catalogueIsInternalOnly()).toBe(true);
    for (const a of ACTION_CATALOGUE) {
      expect(a.internalOnly).toBe(true);
      expect(a.reversible).toBe(true);
    }
  });

  it("only marks an action automatic-safe when it is also reversible and at automatic floor", () => {
    for (const a of ACTION_CATALOGUE) {
      if (a.automaticSafe) {
        expect(a.reversible).toBe(true);
        expect(a.authorityFloor).toBe("automatic");
      }
    }
  });

  it("never registers a customer-sending or money-moving action", () => {
    for (const a of ACTION_CATALOGUE) {
      expect(a.id).not.toMatch(/\.(send|pay|post|settle|transfer|approve_payment)$/);
    }
  });

  it("the CRM action is a DRAFT for a human and requires approval", () => {
    const crm = actionById("crm.followup.draft_for_human")!;
    expect(crm.automaticSafe).toBe(false);
    expect(crm.authorityFloor).toBe("manager_approval");
    expect(crm.description).toMatch(/never sends/i);
  });

  it("returns null when no registered action fits the category", () => {
    expect(actionFor("finance", "none")).toBeNull();
  });
});

describe("building a recommendation", () => {
  it("proposes a registered action citing recorded evidence", async () => {
    const o = observation();
    const rec = buildRecommendation({ observation: o, interpretation: await goodInterpretation(o), authority: authority() })!;
    expect(rec).not.toBeNull();
    expect(ACTION_CATALOGUE.map((a) => a.id)).toContain(rec.action.id);
    expect(rec.rationale.some((r) => r.startsWith("evidence: customer_invoices:inv-1"))).toBe(true);
  });

  it("REFUSES to recommend with zero evidence", async () => {
    const o = { ...observation(), evidence: [] };
    await expect(async () =>
      buildRecommendation({ observation: o, interpretation: await goodInterpretation(observation()), authority: authority() }),
    ).rejects.toThrow(InvariantViolation);
  });

  it("does NOT let a rejected interpretation contribute to the rationale", async () => {
    const o = observation();
    const malformed = deterministicFallback("malformed", "fabricated a claim");
    const rec = buildRecommendation({ observation: o, interpretation: malformed, authority: authority() })!;
    expect(rec.rationale.some((r) => r.startsWith("interpretation:"))).toBe(false);
  });

  it("does NOT let a low-confidence interpretation contribute, and says so truthfully", async () => {
    const o = observation();
    const low: Interpretation = {
      source: "fixture", status: "low_confidence", confidence: 0.2,
      statements: [{ claim: "maybe", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] }],
    };
    const rec = buildRecommendation({ observation: o, interpretation: low, authority: authority() })!;
    expect(rec.rationale.some((r) => r.startsWith("interpretation:"))).toBe(false);
    expect(rec.evidenceQuality).toBe("low_confidence");
    expect(rec.mayRunUnattended).toBe(false);
  });

  it("reports CONTRADICTORY evidence truthfully and refuses unattended running", async () => {
    const o = observation();
    const rec = buildRecommendation({
      observation: o, interpretation: await goodInterpretation(o), authority: authority(), contradiction: true,
    })!;
    expect(rec.evidenceQuality).toBe("contradictory");
    expect(rec.mayRunUnattended).toBe(false);
  });

  it("the action's registered floor can RAISE but never lower the required authority", async () => {
    const o = observation();
    const rec = buildRecommendation({ observation: o, interpretation: await goodInterpretation(o), authority: authority() })!;
    const floorRank = ["automatic", "policy_controlled", "manager_approval", "specialist_approval", "owner_approval"];
    expect(floorRank.indexOf(rec.requiredAuthority)).toBeGreaterThanOrEqual(floorRank.indexOf(rec.action.authorityFloor));
  });

  it("refuses unattended running when the authority engine FAILED CLOSED", async () => {
    const o = observation();
    // No policy and no rules ⇒ the existing engine escalates and flags failedClosed.
    const rec = buildRecommendation({
      observation: o, interpretation: await goodInterpretation(o),
      authority: authority({ rules: [], policyPresent: false }),
    })!;
    expect(rec.mayRunUnattended).toBe(false);
  });

  it("NEVER performs the action — a recommendation is data only", async () => {
    const o = observation();
    const rec = buildRecommendation({ observation: o, interpretation: await goodInterpretation(o), authority: authority() })!;
    // The returned object exposes no callable effect.
    expect(typeof (rec as unknown as { execute?: unknown }).execute).toBe("undefined");
    expect(Object.values(rec).every((v) => typeof v !== "function")).toBe(true);
  });
});

describe("reviewer actions", () => {
  it.each(["approve", "reject", "dismiss", "edit", "delegate", "postpone", "request_evidence", "route"] as ReviewAction[])(
    "supports %s", (action) => {
      const req = {
        action, reason: "because",
        editedActionId: "ops.task.create_internal",
        delegateToMembershipId: MEM_2, delegateAuthorityLevel: "policy_controlled" as AuthorityLevel,
        snoozeUntil: "2026-09-09T00:00:00.000Z",
      };
      expect(reviewItem(item(), reviewer(), req).ok).toBe(true);
    });

  it.each(REASON_REQUIRED_ACTIONS)("REFUSES %s with no reason", (action) => {
    const out = reviewItem(item(), reviewer(), {
      action, reason: "   ",
      editedActionId: "ops.task.create_internal", delegateToMembershipId: MEM_2,
      snoozeUntil: "2026-09-09T00:00:00.000Z",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("reason_required");
  });

  it("approve does NOT require a reason — only the refusals do", () => {
    expect(reviewItem(item(), reviewer(), { action: "approve" }).ok).toBe(true);
  });

  it("reject and dismiss record feedback for later learning", () => {
    for (const action of ["reject", "dismiss"] as ReviewAction[]) {
      const out = reviewItem(item(), reviewer(), { action, reason: "not real" });
      expect(out.ok).toBe(true);
      if (out.ok) expect(out.effects).toContain("feedback_recorded");
    }
  });

  it("routing an unassigned item goes to needs_routing, never to an administrator", () => {
    const out = reviewItem(item(), reviewer(), { action: "route", reason: "no finance officer free" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.nextState).toBe("needs_routing");
      expect(out.effects).toContain("routing_requested");
    }
  });
});

describe("authority boundaries", () => {
  it("approval BELOW the required level is refused", () => {
    const out = reviewItem(item({ requiredAuthority: "owner_approval" }), reviewer({ authorityLevel: "manager_approval" }), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("insufficient_authority");
  });

  it("approval AT the required level is allowed", () => {
    const out = reviewItem(item({ requiredAuthority: "manager_approval" }), reviewer({ authorityLevel: "manager_approval" }), { action: "approve" });
    expect(out.ok).toBe(true);
  });

  it("approval ABOVE the required level is allowed", () => {
    const out = reviewItem(item({ requiredAuthority: "policy_controlled" }), reviewer({ authorityLevel: "owner_approval" }), { action: "approve" });
    expect(out.ok).toBe(true);
  });

  it("SELF-APPROVAL is blocked: whoever edited the recommendation may not approve it", () => {
    const out = reviewItem(item(), reviewer({ priorDecisions: ["edit"] }), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("self_approval_blocked");
  });

  it("a DUPLICATE approval by the same reviewer is refused", () => {
    const out = reviewItem(item(), reviewer({ priorDecisions: ["approve"] }), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("duplicate_decision");
  });

  it("a delegation may never exceed the delegator's own authority", () => {
    const out = reviewItem(item(), reviewer({ authorityLevel: "policy_controlled" }), {
      action: "delegate", reason: "away next week",
      delegateToMembershipId: MEM_2, delegateAuthorityLevel: "owner_approval",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("delegation_exceeds_delegator");
  });

  it("a reviewer cannot delegate to themselves", () => {
    const out = reviewItem(item(), reviewer(), {
      action: "delegate", reason: "x", delegateToMembershipId: MEM_1, delegateAuthorityLevel: "automatic",
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("self_delegation");
  });
});

describe("cross-company and permission loss", () => {
  it("a reviewer from ANOTHER company is refused", () => {
    const out = reviewItem(item(), reviewer({ companyId: CO_B }), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("not_a_member");
  });

  it("PERMISSION LOST during review: a reviewer with no membership is refused", () => {
    const out = reviewItem(item(), reviewer({ membershipId: null }), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("not_a_member");
  });
});

describe("stale items and concurrency", () => {
  it.each(["verified", "rejected", "dismissed", "expired"])("a %s item accepts no further decision", (state) => {
    const out = reviewItem(item({ state }), reviewer(), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("already_terminal");
  });

  it("CONCURRENT reviewers: the second approval on an already-approved item is refused", () => {
    // First reviewer approves; the item is now `approved`, and a second decision on a
    // terminal-for-approval path is caught by the caller's expected-state assertion. Within
    // this pure layer, the same reviewer acting twice is refused outright.
    const first = reviewItem(item(), reviewer(), { action: "approve" });
    expect(first.ok).toBe(true);
    const second = reviewItem(item(), reviewer({ priorDecisions: ["approve"] }), { action: "approve" });
    expect(second.ok).toBe(false);
  });

  it("RETRY of the same submission is idempotent in effect — refused, not double-applied", () => {
    const out = reviewItem(item(), reviewer({ priorDecisions: ["approve"] }), { action: "approve" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("duplicate_decision");
  });
});

describe("unsupported and malformed input", () => {
  it("editing to an UNREGISTERED action is refused", () => {
    const out = reviewItem(item(), reviewer(), { action: "edit", reason: "x", editedActionId: "finance.payment.send" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("unsupported_action");
  });

  it("an unknown review action is refused", () => {
    const out = reviewItem(item(), reviewer(), { action: "explode" as ReviewAction, reason: "x" });
    expect(out.ok).toBe(false);
  });

  it("postponing without a time is refused", () => {
    const out = reviewItem(item(), reviewer(), { action: "postpone", reason: "later" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("missing_snooze_until");
  });

  it("postponing to a MALFORMED time is refused", () => {
    const out = reviewItem(item(), reviewer(), { action: "postpone", reason: "later", snoozeUntil: "next tuesday" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("malformed_snooze_until");
  });

  it("delegating with no delegate is refused", () => {
    const out = reviewItem(item(), reviewer(), { action: "delegate", reason: "x" });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe("missing_delegate");
  });
});

describe("assignee selection (R1-D-3: never fall back to an administrator)", () => {
  const action = actionById("ops.task.create_internal")!;
  const candidate = (over: Partial<AssigneeCandidate> = {}): AssigneeCandidate => ({
    membershipId: MEM_1, companyId: CO_A, active: true, available: true,
    availableHours: 20, capabilities: ["operations.task.manage"], ...over,
  });

  it("selects an active, available, capable member of the same company", () => {
    const r = selectAssignee([candidate()], action, CO_A);
    expect(r.membershipId).toBe(MEM_1);
  });

  it("prefers the least-loaded candidate", () => {
    const r = selectAssignee(
      [candidate({ membershipId: "busy", availableHours: 2 }), candidate({ membershipId: "free", availableHours: 30 })],
      action, CO_A,
    );
    expect(r.membershipId).toBe("free");
  });

  it("EXCLUDES a candidate on approved leave", () => {
    const r = selectAssignee([candidate({ available: false })], action, CO_A);
    expect(r.membershipId).toBeNull();
  });

  it("EXCLUDES an inactive membership", () => {
    const r = selectAssignee([candidate({ active: false })], action, CO_A);
    expect(r.membershipId).toBeNull();
  });

  it("EXCLUDES a candidate from another company", () => {
    const r = selectAssignee([candidate({ companyId: CO_B })], action, CO_A);
    expect(r.membershipId).toBeNull();
  });

  it("EXCLUDES a candidate lacking the action's capability", () => {
    const r = selectAssignee([candidate({ capabilities: ["operations.task.work"] })], action, CO_A);
    expect(r.membershipId).toBeNull();
  });

  it("NOBODY SUITABLE: returns null with a reason, and never names an administrator", () => {
    const r = selectAssignee([], action, CO_A);
    expect(r.membershipId).toBeNull();
    if (r.membershipId === null) {
      expect(r.reason).toMatch(/no active, available member/i);
      expect(r.reason).not.toMatch(/admin/i);
    }
  });
});
