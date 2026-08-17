/**
 * Company-scoped deterministic authority engine (owner decision: the hardcoded floor is not the
 * permanent implementation).
 *
 * The three properties under test are the ones the owner specified:
 *   - the final level is at least the MAXIMUM of every applicable deterministic rule;
 *   - the model may RAISE authority and may never LOWER it;
 *   - unknown, conflicting or missing policy FAILS CLOSED and escalates.
 *
 * All fixtures are synthetic.
 */
import { describe, it, expect } from "vitest";
import {
  resolveRequiredAuthority,
  applyModelRecommendation,
  actionFloor,
  normalizeAction,
  maxLevel,
  type AuthorityContext,
  type AuthorityRuleRow,
} from "@/policy/authority-engine";
import { planFromObservation } from "@/management/ai-manager/pipeline";
import { ManagementObservation } from "@/schemas/management";

const COMPANY = "co-synthetic-1";
const MEMBERSHIP = "mem-synthetic-1";

const rule = (over: Partial<AuthorityRuleRow> = {}): AuthorityRuleRow => ({
  id: "r1",
  membership_id: MEMBERSHIP,
  company_id: COMPANY,
  domain: "finance",
  max_amount: "50000.00",
  currency: "LKR",
  is_unlimited: false,
  is_company_wide: false,
  ...over,
});

const ctx = (over: Partial<AuthorityContext> = {}): AuthorityContext => ({
  companyId: COMPANY,
  actorMembershipId: MEMBERSHIP,
  rules: [rule()],
  policyPresent: true,
  ...over,
});

describe("authority engine — fails closed on unknown, missing or conflicting policy", () => {
  it("no active approval policy escalates and is marked failedClosed", () => {
    const r = resolveRequiredAuthority({ domain: "general" }, ctx({ policyPresent: false }));
    expect(r.failedClosed).toBe(true);
    expect(r.level).toBe("manager_approval");
    expect(r.reasons.join(" ")).toContain("no active approval policy");
  });

  it("an unresolvable actor membership escalates", () => {
    const r = resolveRequiredAuthority({ domain: "general" }, ctx({ actorMembershipId: null }));
    expect(r.failedClosed).toBe(true);
    expect(r.reasons.join(" ")).toContain("no resolvable membership");
  });

  it("an amount with no covering rule escalates rather than defaulting to automatic", () => {
    const r = resolveRequiredAuthority(
      { domain: "procurement", amount: "100.00", currency: "LKR" },
      ctx({ rules: [rule({ domain: "finance" })] }), // wrong domain, not company-wide
    );
    expect(r.failedClosed).toBe(true);
    expect(r.reasons.join(" ")).toContain("no authority rule covers this actor and domain");
  });

  it("an amount in a currency no rule covers escalates and is never converted", () => {
    const r = resolveRequiredAuthority(
      { domain: "finance", amount: "1.00", currency: "USD" },
      ctx(), // ceiling is LKR 50,000 — one dollar is numerically tiny, and irrelevant
    );
    expect(r.failedClosed).toBe(true);
    expect(r.reasons.join(" ")).toContain("never converted");
  });

  it("an amount with no currency at all escalates", () => {
    const r = resolveRequiredAuthority({ domain: "finance", amount: "1000.00", currency: null }, ctx());
    expect(r.failedClosed).toBe(true);
  });

  it("an unrecognised action escalates — the classification is closed, not a denylist", () => {
    const r = resolveRequiredAuthority({ domain: "general", action: "some.brand.new.action" }, ctx());
    expect(r.failedClosed).toBe(true);
    expect(r.reasons.join(" ")).toContain("not in the authority classification");
  });

  it("conflicting ceilings resolve to the LOWEST, so a stray permissive row cannot widen authority", () => {
    const r = resolveRequiredAuthority(
      { domain: "finance", amount: "60000.00", currency: "LKR" },
      ctx({ rules: [rule({ id: "a", max_amount: "50000.00" }), rule({ id: "b", max_amount: "900000.00" })] }),
    );
    expect(r.level).toBe("specialist_approval");
    expect(r.reasons.join(" ")).toContain("the lowest governs");
  });
});

describe("authority engine — evasion classes that defeated the old substring denylist", () => {
  it("fullwidth unicode folds to the same action", () => {
    expect(normalizeAction("ｐａｙｍｅｎｔ_release")).toBe("paymentrelease");
    expect(actionFloor("finance.PAYMENT.execute")).toBe("owner_approval");
  });

  it("separator-split names cannot dodge the classification", () => {
    expect(normalizeAction("p-a-y-m-e-n-t")).toBe("payment");
    expect(actionFloor("finance.p-a-y-m-e-n-t.execute")).toBe("owner_approval");
  });

  it("money-moving synonyms are classified, not missed", () => {
    for (const a of [
      "finance.remit_funds",
      "finance.wire_transfer.send",
      "finance.disbursement.create",
      "finance.payout",
      "finance.refund.issue",
    ]) {
      expect(actionFloor(a)).toBe("owner_approval");
    }
  });

  it("HR, ledger, contract and permission synonyms are classified", () => {
    expect(actionFloor("hr.employee.offboard")).toBe("owner_approval");
    expect(actionFloor("admin.role.widen")).toBe("owner_approval");
    expect(actionFloor("legal.contract.sign")).toBe("owner_approval");
    expect(actionFloor("finance.journal_entry.create")).toBe("specialist_approval");
    expect(actionFloor("finance.supplier_bank_detail.update")).toBe("specialist_approval");
  });

  it("a genuinely routine action carries no escalation", () => {
    expect(actionFloor("ops.task.create")).toBe("automatic");
    const r = resolveRequiredAuthority({ domain: "general", action: "ops.task.create" }, ctx());
    expect(r.level).toBe("automatic");
    expect(r.failedClosed).toBe(false);
  });
});

describe("authority engine — the result is the maximum of all applicable rules", () => {
  it("domain, action, impact and amount floors compose to the highest", () => {
    const r = resolveRequiredAuthority(
      {
        domain: "finance", // manager
        action: "finance.payment.execute", // owner
        amount: "60000.00", // over ceiling → specialist
        currency: "LKR",
        impact: { financial: true }, // specialist
      },
      ctx(),
    );
    expect(r.level).toBe("owner_approval"); // the maximum, not the last rule evaluated
  });

  it("maxLevel is order-independent", () => {
    expect(maxLevel(["automatic", "owner_approval", "manager_approval"])).toBe("owner_approval");
    expect(maxLevel(["owner_approval", "automatic"])).toBe("owner_approval");
    expect(maxLevel([])).toBe("automatic");
  });

  it("an amount inside an unlimited ceiling does not escalate on amount", () => {
    const r = resolveRequiredAuthority(
      { domain: "procurement", amount: "99999999.00", currency: "LKR" },
      ctx({ rules: [rule({ domain: "procurement", is_unlimited: true, max_amount: null })] }),
    );
    expect(r.reasons.join(" ")).not.toContain("exceeds the ceiling");
  });

  it("exact ceiling passes, one cent over escalates (no float drift)", () => {
    const at = resolveRequiredAuthority({ domain: "finance", amount: "50000.00", currency: "LKR" }, ctx());
    expect(at.reasons.join(" ")).not.toContain("exceeds the ceiling");
    const over = resolveRequiredAuthority({ domain: "finance", amount: "50000.01", currency: "LKR" }, ctx());
    expect(over.reasons.join(" ")).toContain("exceeds the ceiling");
  });
});

describe("authority engine — the model may raise but never lower", () => {
  const deterministic = { level: "specialist_approval" as const, reasons: [], failedClosed: false };

  it("a model claiming a LOWER level is overruled", () => {
    for (const claim of ["automatic", "policy_controlled", "manager_approval"] as const) {
      const r = applyModelRecommendation(deterministic, claim);
      expect(r.level).toBe("specialist_approval");
      expect(r.reasons.join(" ")).toContain("deterministic result governs");
    }
  });

  it("a model claiming a HIGHER level is respected", () => {
    const r = applyModelRecommendation(deterministic, "owner_approval");
    expect(r.level).toBe("owner_approval");
  });

  it("an absent model claim changes nothing", () => {
    expect(applyModelRecommendation(deterministic, null).level).toBe("specialist_approval");
  });
});

describe("planFromObservation — the engine governs when a context is supplied", () => {
  const obs = (over: Partial<ManagementObservation> = {}) =>
    ManagementObservation.parse({
      sourceEventId: "evt-1",
      scope: { companyId: COMPANY },
      confidence: 0.9,
      requiredAuthority: "automatic",
      detectedTasks: [{ title: "Synthetic task" }],
      ...over,
    });

  it("a model claiming automatic on a financial matter is overruled by company policy", () => {
    const plan = planFromObservation(obs({ impact: { financial: "LKR 2.4M to a supplier" } }), ctx());
    expect(plan.requiredAuthority).toBe("specialist_approval");
    expect(plan.needsApproval).toBe(true);
    expect(plan.authorityReasons.join(" ")).toContain("deterministic result governs");
  });

  it("with NO authority context the interim floor still applies and is marked fail-closed", () => {
    const plan = planFromObservation(obs({ impact: { financial: "LKR 2.4M" } }));
    expect(plan.requiredAuthority).toBe("specialist_approval");
    expect(plan.authorityFailedClosed).toBe(true);
    expect(plan.authorityReasons.join(" ")).toContain("interim floor");
  });

  it("a missing company policy escalates a matter the model called routine", () => {
    const plan = planFromObservation(obs(), ctx({ policyPresent: false }));
    expect(plan.requiredAuthority).toBe("manager_approval");
    expect(plan.authorityFailedClosed).toBe(true);
  });

  it("a genuinely routine observation under real policy stays automatic", () => {
    const plan = planFromObservation(obs(), ctx());
    expect(plan.requiredAuthority).toBe("automatic");
    expect(plan.needsApproval).toBe(false);
    expect(plan.authorityFailedClosed).toBe(false);
  });
});
