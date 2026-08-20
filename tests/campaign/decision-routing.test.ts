/**
 * Overnight campaign — deterministic authority evaluation over the synthetic scenario pack.
 *
 * The campaign asks whether the system routes clear / ambiguous / conflicting / high-risk
 * business situations to the right human authority. That question has a deterministic answer
 * in this codebase: `routeDecision` decides with NO model in the loop, so it can be evaluated
 * exactly rather than judged. A model's opinion is never the authority here — this file is.
 *
 * What a failure here means: an action that touches money, bank details, contracts, HR, the
 * ledger or permissions could run without the human who is accountable for it.
 */
import { describe, it, expect } from "vitest";
import { routeDecision, AUTHORITY_LEVELS } from "@/management/policy/route-decision";
import { DecisionProposal } from "@/schemas/management";
import { SCENARIOS, EVASION_PROBES, type Level } from "./scenarios";

const rank = (l: string) => (AUTHORITY_LEVELS as readonly string[]).indexOf(l);

describe("campaign — every scenario proposal is schema-valid before any routing", () => {
  // The pipeline is schema → policy → permission → audit. A proposal that does not parse must
  // never reach the router, so the pack itself has to be valid input.
  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s parses as a DecisionProposal", (_id, s) => {
    expect(DecisionProposal.safeParse(s.proposal).success).toBe(true);
  });
});

describe("campaign — deterministic authority routing", () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s routes to an accepted outcome", (_id, s) => {
    const r = routeDecision(s.proposal, s.ctx);

    expect(s.expect.routing).toContain(r.routing);
    expect(rank(r.requiredLevel)).toBeGreaterThanOrEqual(rank(s.expect.minLevel));

    for (const fragment of s.expect.reasonContains ?? []) {
      expect(r.reasons.join(" | ")).toContain(fragment);
    }
  });

  it("no high-risk scenario is ever allowed to run without a human", () => {
    const escaped = SCENARIOS.filter((s) => s.class === "high_risk").filter(
      (s) => routeDecision(s.proposal, s.ctx).routing !== "require_approval",
    );
    expect(escaped.map((s) => s.id)).toEqual([]);
  });

  it("high confidence and an understated risk label cannot buy authority (RSK-01)", () => {
    // RSK-01 is a bank payment submitted with confidence 0.99, risk "low", and an amount INSIDE
    // the actor's ceiling — every dial an attacker or an over-eager model controls, set to the
    // most permissive value. It must still require the owner.
    const s = SCENARIOS.find((x) => x.id === "RSK-01")!;
    const r = routeDecision(s.proposal, s.ctx);
    expect(r.routing).toBe("require_approval");
    expect(r.requiredLevel).toBe("owner_approval");
  });

  it("the actor's own permission never satisfies a never-autonomous action", () => {
    // Self-approval check: give the actor the exact permission the proposal asks for and a
    // ceiling far above the amount. A never-autonomous action must not become routine.
    const s = SCENARIOS.find((x) => x.id === "RSK-01")!;
    const r = routeDecision(s.proposal, {
      actorPermissions: [s.proposal.requiredPermission, "*"],
      actorAuthorityMax: { amount: "999999999.00", currency: "LKR" },
    });
    expect(r.routing).toBe("require_approval");
    expect(rank(r.requiredLevel)).toBeGreaterThanOrEqual(rank("specialist_approval" as Level));
  });

  it("a currency mismatch escalates instead of silently converting", () => {
    const r = routeDecision(
      { ...SCENARIOS[0]!.proposal, limit: { amount: "1.00", currency: "USD" }, risk: "low" },
      { actorAuthorityMax: { amount: "50000.00", currency: "LKR" }, actorPermissions: [] },
    );
    // One US dollar is numerically tiny against a 50,000 LKR ceiling. Converting would be a
    // guess; the router must treat the mismatch as over-limit.
    expect(r.routing).toBe("require_approval");
    expect(r.reasons.join(" | ")).toContain("exceeds the actor's delegated authority");
  });

  it("an exact-ceiling amount is allowed and one cent over is not (no float drift)", () => {
    const base = { ...SCENARIOS[1]!.proposal, risk: "low" as const };
    const ctx = { actorAuthorityMax: { amount: "50000.00", currency: "LKR" }, actorPermissions: [] };

    const atCeiling = routeDecision({ ...base, limit: { amount: "50000.00", currency: "LKR" } }, ctx);
    expect(atCeiling.reasons.join(" | ")).not.toContain("exceeds");

    const overByACent = routeDecision({ ...base, limit: { amount: "50000.01", currency: "LKR" } }, ctx);
    expect(overByACent.reasons.join(" | ")).toContain("exceeds");
  });

  it("amounts beyond float precision still compare correctly", () => {
    // 2^53 minor units is where a JS float stops being able to tell two amounts apart.
    const base = { ...SCENARIOS[1]!.proposal, risk: "low" as const };
    const ctx = { actorAuthorityMax: { amount: "9007199254740992.00", currency: "LKR" }, actorPermissions: [] };
    const over = routeDecision({ ...base, limit: { amount: "9007199254740993.00", currency: "LKR" } }, ctx);
    expect(over.reasons.join(" | ")).toContain("exceeds");
  });
});

describe("campaign — never-autonomous evasion probes", () => {
  // Each probe performs a banned operation while trying to dodge the substring match. A probe
  // that reaches "auto" is a real authority bypass, so each is reported by id.
  const results = EVASION_PROBES.map((p) => {
    const proposal: DecisionProposal = {
      ...SCENARIOS[0]!.proposal,
      action: p.action,
      risk: p.risk,
      confidence: 0.99,
      requiredPermission: "ops.task.create",
    };
    const r = routeDecision(proposal, {
      actorPermissions: ["ops.task.create"],
      actorAuthorityMax: { amount: "999999999.00", currency: "LKR" },
    });
    return { ...p, routing: r.routing, level: r.requiredLevel };
  });

  it("case variations of a banned substring are still caught", () => {
    // NEVER_AUTONOMOUS matches against a lower-cased action, so casing must not matter.
    const cased = results.filter((r) => ["EVA-01", "EVA-02"].includes(r.id));
    expect(cased.map((r) => `${r.id}:${r.routing}`)).toEqual(["EVA-01:require_approval", "EVA-02:require_approval"]);
  });

  it("KNOWN DEFECT (D-001) — records which synonym probes reach automatic execution; NOT an assertion of safety", () => {
    // These probes name real money/HR/ledger/permission operations without containing a banned
    // substring. Whether they are caught is a property of the deny-list, and the campaign's job
    // is to MEASURE it rather than assert a convenient answer. The measured set is asserted
    // exactly so that any future change to the deny-list shows up here as a diff.
    const auto = results.filter((r) => r.routing === "auto").map((r) => r.id).sort();
    expect(auto).toEqual(["EVA-03", "EVA-04", "EVA-05", "EVA-06", "EVA-07", "EVA-08"]);
  });

  it("TRIPWIRE — D-001 is only latent while routeDecision has no production caller", () => {
    // The severity of D-001 rests entirely on a call-graph fact: nothing in production consumes
    // routeDecision, so its evadable denylist protects nothing and endangers nothing. That fact is
    // one import away from changing. This test fails the moment a non-test, non-eval module imports
    // it — turning a documented latent finding into an immediate, loud blocker.
    // Match real IMPORT statements, not the text "routeDecision" — a prose mention in a comment is
    // not a consumer, and a grep that cannot tell the difference produces exactly the kind of
    // false signal this campaign found elsewhere.
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync(
      `grep -rlnE "^\\s*import[^;]*from \\"@/management/policy/route-decision\\"" src --include=*.ts --include=*.tsx || true`,
      { cwd: process.cwd(), encoding: "utf8" },
    );
    const importers = out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((f) => !f.startsWith("src/ai/evals/")) // static eval fixtures, not a runtime consumer
      .filter((f) => f !== "src/management/ai-manager/case.ts"); // type-only import — verified by reading

    expect(importers).toEqual([]);
  });
});

describe("campaign — scenario coverage is honest about what is not implemented", () => {
  it("every class of situation is represented", () => {
    const classes = new Set(SCENARIOS.map((s) => s.class));
    expect([...classes].sort()).toEqual(["ambiguous", "clear", "conflicting", "high_risk"]);
  });

  it("missing-link notes are attached to scenarios the system cannot actually reason about", () => {
    // These are reported as MISSING LINKS in the campaign report. The test exists so the notes
    // cannot quietly disappear and leave a scenario looking like proven intelligence.
    const noted = SCENARIOS.filter((s) => (s.unimplemented?.length ?? 0) > 0).map((s) => s.id);
    expect(noted).toEqual(["AMB-01", "AMB-02", "AMB-03", "CNF-01", "CNF-02", "CNF-03", "RSK-07"]);
  });

  it("scenarios whose outcome comes from a proposer-supplied risk label say so", () => {
    // The honest failure mode of a pack like this is a scenario that LOOKS like the system judged a
    // business situation when the author's own `risk` input decided it. Every such scenario must
    // disclose it, so the rubric's pass count is not read as proven intelligence.
    const riskDriven = ["AMB-03", "CNF-02", "CNF-03", "RSK-07"];
    for (const id of riskDriven) {
      const s = SCENARIOS.find((x) => x.id === id)!;
      expect(s.unimplemented?.join(" ")).toMatch(/risk|input, not a system judgement/i);
    }
  });
});
