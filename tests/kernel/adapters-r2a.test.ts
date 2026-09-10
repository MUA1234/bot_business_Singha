/**
 * R2A — the seven newly connected managed domains, behaviourally.
 *
 * Proves all twelve register, that each new adapter wraps its real detector, that the safety
 * rules hold identically across domains, and that the five R1 adapters are unchanged.
 */
import { describe, it, expect } from "vitest";
import {
  detectGovernanceObservations, GOVERNANCE_SOURCE,
  detectObjectiveObservations, OBJECTIVES_SOURCE,
  detectMarketingObservations, MARKETING_SOURCE,
  detectProcurementObservations, PROCUREMENT_SOURCE,
  detectAssetObservations, ASSETS_SOURCE,
  detectLegalObservations, LEGAL_SOURCE,
  detectProviderObservations, PROVIDERS_SOURCE,
  detectFinanceObservations, FINANCE_SOURCE,
  OBSERVATION_SOURCES, specFor,
} from "@/kernel/adapters";
import { assertObservationSafe, ObservationRejected, type Observation } from "@/kernel/observation";
import { ingestObservation } from "@/kernel/ingest";
import { ACTION_CATALOGUE, actionFor, catalogueIsInternalOnly } from "@/kernel/catalogue";
import { DEPARTMENTS, type Department } from "@/kernel/types";
import { buildRecommendation } from "@/kernel/recommend";
import { fixtureInterpreter, interpretWithGuards } from "@/kernel/interpretation";
import type { AuthorityContext } from "@/policy/authority-engine";
import type { GovernanceScanInput } from "@/kernel/adapters/governance";
import type { ObjectivesScanInput } from "@/kernel/adapters/objectives";
import type { MarketingScanInput } from "@/kernel/adapters/marketing";
import type { ProcurementScanInput } from "@/kernel/adapters/procurement";
import type { AssetsScanInput } from "@/kernel/adapters/assets";
import type { LegalScanInput } from "@/kernel/adapters/legal";
import type { ProvidersScanInput } from "@/kernel/adapters/providers";

const CO_A = "11111111-1111-1111-1111-111111111111";
const CO_B = "22222222-2222-2222-2222-222222222222";
const CORR = "corr-r2a";
const NOW = new Date("2026-09-02T09:00:00.000Z");
const base = (companyId = CO_A) => ({ companyId, correlationId: CORR, now: NOW });

// ── fixtures: each shaped for its real detector ───────────────────────────────────────
const governanceInput = (c = CO_A): GovernanceScanInput => ({
  ...base(c),
  directives: [{
    id: "dir-1", status: "issued", response_required_by: "2026-08-01T00:00:00.000Z",
    escalation_chain: ["u1", "u2"], escalation_level: 0, acknowledged_at: null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  }],
});

const objectivesInput = (c = CO_A): ObjectivesScanInput => ({
  ...base(c),
  objectives: [{
    id: "obj-1", target_value: 100, current_value: 5,
    period_start: "2026-01-01", period_end: "2026-12-31", status: "active",
    updated_at: "2026-09-01T00:00:00.000Z",
  }],
});

const marketingInput = (c = CO_A): MarketingScanInput => ({
  ...base(c),
  campaigns: [{ id: "camp-1", status: "draft", audience_id: null, sent_count: 0, created_at: "2026-07-01T00:00:00.000Z" }],
});

const procurementInput = (c = CO_A): ProcurementScanInput => ({
  ...base(c),
  inventory: [{ id: "inv-item-1", quantity_on_hand: 2, reorder_level: 10, updated_at: "2026-09-01T00:00:00.000Z" }],
});

const assetsInput = (c = CO_A): AssetsScanInput => ({
  ...base(c),
  documents: [{ id: "doc-1", vehicle_id: "veh-1", doc_type: "insurance", expiry_date: "2026-08-01", created_at: "2026-09-01T00:00:00.000Z" }],
});

const legalInput = (c = CO_A): LegalScanInput => ({
  ...base(c),
  records: [{ id: "lic-1", kind: "licence", due_date: "2026-08-01", status: "active", updated_at: "2026-09-01T00:00:00.000Z" }],
});

const providersInput = (c = CO_A): ProvidersScanInput => ({
  ...base(c),
  providers: [{
    id: "sp-1", status: "active", compliance_status: "expired",
    insurance_status: "valid", insurance_expiry: "2027-01-01", updated_at: "2026-09-01T00:00:00.000Z",
  }],
});

const sevenNew = (c = CO_A): Observation[] => [
  ...detectGovernanceObservations(governanceInput(c)),
  ...detectObjectiveObservations(objectivesInput(c)),
  ...detectMarketingObservations(marketingInput(c)),
  ...detectProcurementObservations(procurementInput(c)),
  ...detectAssetObservations(assetsInput(c)),
  ...detectLegalObservations(legalInput(c)),
  ...detectProviderObservations(providersInput(c)),
];

describe("all twelve managed domains are registered", () => {
  it("the Department union and the registry agree, at twelve", () => {
    expect(DEPARTMENTS).toHaveLength(12);
    expect(OBSERVATION_SOURCES).toHaveLength(12);
    const registered = new Set(OBSERVATION_SOURCES.map((s) => s.department));
    for (const d of DEPARTMENTS) expect(registered.has(d), `${d} has no registered source`).toBe(true);
  });

  it("every source has a cadence and at least one trigger mode", () => {
    for (const s of OBSERVATION_SOURCES) {
      expect(specFor(s.source), s.source).not.toBeNull();
      expect(s.supportsEvent || s.supportsScheduled || s.supportsManual, s.source).toBe(true);
      if (s.supportsScheduled) expect(s.cadenceSeconds ?? 0, s.source).toBeGreaterThanOrEqual(60);
    }
  });

  it("the seven new domains each produce an observation from their real detector", () => {
    const byDept = new Map(sevenNew().map((o) => [o.department, o]));
    for (const d of ["governance", "objectives", "marketing", "procurement", "assets", "legal", "providers"] as Department[]) {
      expect(byDept.has(d), `${d} produced nothing`).toBe(true);
    }
  });

  it("every new observation satisfies the common contract", () => {
    for (const o of sevenNew()) {
      expect(() => assertObservationSafe(o, { companyId: CO_A }), o.department).not.toThrow();
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.correlationId).toBe(CORR);
      expect(o.confidence).toBe(1);
      expect(o.identityKey).toContain(CO_A);
    }
  });
});

describe("the catalogue covers twelve domains and stays internal-only", () => {
  it("every action is internal-only and reversible", () => {
    expect(catalogueIsInternalOnly()).toBe(true);
    for (const a of ACTION_CATALOGUE) expect(a.reversible, a.id).toBe(true);
  });

  it("each new department has its own action, so none borrows another's", () => {
    for (const d of ["governance", "objectives", "marketing", "procurement", "assets", "legal", "providers"] as Department[]) {
      expect(ACTION_CATALOGUE.some((a) => a.department === d), `${d} has no action`).toBe(true);
    }
  });

  it("a new domain's suggested category resolves to an action IN THAT DOMAIN", () => {
    for (const o of sevenNew()) {
      const action = actionFor(o.department, o.suggestedActionCategory);
      expect(action, `${o.department}/${o.suggestedActionCategory}`).not.toBeNull();
      expect(action!.department, `${o.department} borrowed ${action!.id}`).toBe(o.department);
    }
  });

  it("NO new action is automatic-safe — none of the seven may run unattended", () => {
    for (const d of ["governance", "objectives", "marketing", "procurement", "assets", "legal", "providers"]) {
      for (const a of ACTION_CATALOGUE.filter((x) => x.department === d)) {
        expect(a.automaticSafe, a.id).toBe(false);
      }
    }
  });

  it("legal requires the HIGHEST authority — an expiry is a legal exposure", () => {
    const legal = ACTION_CATALOGUE.find((a) => a.department === "legal")!;
    expect(legal.authorityFloor).toBe("specialist_approval");
  });

  it("no new action sends, pays, posts, settles or engages", () => {
    for (const a of ACTION_CATALOGUE) {
      expect(a.id).not.toMatch(/\.(send|pay|post|settle|transfer|launch|engage|renew)$/);
    }
  });
});

describe("recommendations from the new domains never run unattended", () => {
  const authority = (): AuthorityContext => ({
    companyId: CO_A, actorMembershipId: null,
    rules: [{ domain: "finance", max_amount: "1000000", is_unlimited: false } as never],
    policyPresent: true,
  });

  it("every new domain's recommendation requires a human", async () => {
    for (const o of sevenNew()) {
      const interpretation = await interpretWithGuards(o, o.evidence, fixtureInterpreter());
      const rec = buildRecommendation({ observation: o, interpretation, authority: authority() });
      expect(rec, o.department).not.toBeNull();
      expect(rec!.action.internalOnly).toBe(true);
      expect(rec!.mayRunUnattended, `${o.department} may run unattended`).toBe(false);
    }
  });
});

describe("company isolation holds for the new domains", () => {
  it("identical conditions in two companies produce distinct identity keys", () => {
    const keysA = new Set(sevenNew(CO_A).map((o) => o.identityKey));
    for (const o of sevenNew(CO_B)) expect(keysA.has(o.identityKey)).toBe(false);
  });

  it("an observation scanned for A is refused under B's context", () => {
    for (const o of sevenNew(CO_A)) {
      expect(() => assertObservationSafe(o, { companyId: CO_B }), o.department).toThrow(/company identity/i);
    }
  });

  it("a forged company id is rejected by ingest", () => {
    for (const o of sevenNew(CO_A)) {
      const d = ingestObservation({ ...o, companyId: CO_B }, { companyId: CO_A }, null);
      expect(d.action).toBe("reject");
    }
  });
});

describe("minimum safe summary — the new domains copy no payload", () => {
  it("governance never copies the directive body, title or the owner's response", () => {
    const [o] = detectGovernanceObservations(governanceInput());
    const blob = JSON.stringify([o!.facts, o!.evidence, o!.summary]);
    // Only two fields cross the boundary: the status and the detector's own escalation
    // reason (a generated sentence naming the due date). The directive's own text does not.
    expect(Object.keys(o!.facts).sort()).toEqual(["directive_status", "escalation_reason"]);
    expect(blob).not.toMatch(/"(body|title|response|issued_to|issued_by)"/i);
  });

  it("objectives carry bands, never the raw metric value", () => {
    const [o] = detectObjectiveObservations(objectivesInput());
    const blob = JSON.stringify([o!.facts, o!.evidence]);
    expect(blob).not.toContain("100");
    expect(o!.facts.progress_band).toBeTruthy();
  });

  it("procurement carries a cover band, never the quantity or unit cost", () => {
    const [o] = detectProcurementObservations(procurementInput());
    expect(JSON.stringify(o!.facts)).not.toMatch(/quantity|unit_cost|"2"/);
    expect(o!.facts.cover_band).toBeTruthy();
  });

  it("providers carry health flags, never name, pricing or capacity notes", () => {
    const [o] = detectProviderObservations(providersInput());
    expect(JSON.stringify([o!.facts, o!.evidence])).not.toMatch(/price|capacity|capabilities|name/i);
    expect(o!.facts.provider_health).toBe("blocked");
  });

  it("a sensitive fact key is refused in every new domain", () => {
    for (const o of sevenNew()) {
      const bad: Observation = { ...o, facts: { customer_name: "x" } };
      expect(() => assertObservationSafe(bad, { companyId: CO_A }), o.department).toThrow(ObservationRejected);
    }
  });
});

describe("resolved, stale and duplicate handling in the new domains", () => {
  it("an acknowledged or closed directive produces nothing", () => {
    for (const status of ["acknowledged", "closed"] as const) {
      const input = governanceInput();
      input.directives[0]!.status = status;
      expect(detectGovernanceObservations(input)).toEqual([]);
    }
  });

  it("a done objective, and one whose period has ended, produce nothing", () => {
    const done = objectivesInput();
    done.objectives[0]!.status = "done";
    expect(detectObjectiveObservations(done)).toEqual([]);

    const past = objectivesInput();
    past.objectives[0]!.period_end = "2026-01-31";
    expect(detectObjectiveObservations(past)).toEqual([]);
  });

  it("an objective with no usable target is NOT judged — no invented verdict", () => {
    const input = objectivesInput();
    input.objectives[0]!.target_value = 0;
    expect(detectObjectiveObservations(input)).toEqual([]);
  });

  it("a completed campaign, and one younger than the stall window, produce nothing", () => {
    const done = marketingInput();
    done.campaigns[0]!.status = "completed";
    expect(detectMarketingObservations(done)).toEqual([]);

    const fresh = marketingInput();
    fresh.campaigns[0]!.created_at = "2026-09-01T00:00:00.000Z";
    expect(detectMarketingObservations(fresh)).toEqual([]);
  });

  it("stock at or above reorder level, and an item with no threshold, produce nothing", () => {
    const ok = procurementInput();
    ok.inventory[0]!.quantity_on_hand = 50;
    expect(detectProcurementObservations(ok)).toEqual([]);

    const noLevel = procurementInput();
    noLevel.inventory[0]!.reorder_level = null;
    expect(detectProcurementObservations(noLevel)).toEqual([]);
  });

  it("a closed legal record produces nothing", () => {
    const input = legalInput();
    input.records[0]!.status = "renewed";
    expect(detectLegalObservations(input)).toEqual([]);
  });

  it("a verified provider, and an archived one, produce nothing", () => {
    const ok = providersInput();
    ok.providers[0]!.compliance_status = "verified";
    ok.providers[0]!.status = "active";
    ok.providers[0]!.insurance_status = "valid";
    expect(detectProviderObservations(ok)).toEqual([]);

    const archived = providersInput();
    archived.providers[0]!.status = "archived";
    expect(detectProviderObservations(archived)).toEqual([]);
  });

  it("identity keys are stable across re-scans and change with the window", () => {
    for (const [a, b] of [
      [detectGovernanceObservations(governanceInput())[0], detectGovernanceObservations(governanceInput())[0]],
      [detectLegalObservations(legalInput())[0], detectLegalObservations(legalInput())[0]],
    ] as const) {
      expect(a!.identityKey).toBe(b!.identityKey);
    }
    const day2 = detectGovernanceObservations({ ...governanceInput(), now: new Date("2026-09-03T09:00:00Z") })[0]!;
    expect(day2.identityKey).not.toBe(detectGovernanceObservations(governanceInput())[0]!.identityKey);
  });

  it("legal record KIND is part of the identity, so two tables never collide", () => {
    const input = legalInput();
    input.records = [
      { id: "same-id", kind: "licence", due_date: "2026-08-01", status: "active" },
      { id: "same-id", kind: "contract", due_date: "2026-08-01", status: "active" },
    ];
    const obs = detectLegalObservations(input);
    expect(obs).toHaveLength(2);
    expect(new Set(obs.map((o) => o.identityKey)).size).toBe(2);
  });
});

describe("the five R1 domains are unchanged by R2A", () => {
  it("finance still produces its observation with the same source and shape", () => {
    const [o] = detectFinanceObservations({
      ...base(),
      invoices: [{ id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
                   updated_at: "2026-09-01T00:00:00.000Z", status: "open" }],
    });
    expect(o!.observationSource).toBe(FINANCE_SOURCE);
    expect(o!.department).toBe("finance");
    expect(o!.facts.outstanding_magnitude).toBe("100k-1m");
  });

  it("the five R1 sources keep their identifiers", () => {
    const ids = OBSERVATION_SOURCES.map((s) => s.source);
    for (const src of ["finance.receivable_overdue", "workforce.capacity_exception",
                       "operations.task_exception", "crm.followup_due", "system.health_degraded"]) {
      expect(ids).toContain(src);
    }
  });

  it("the seven new source ids follow the same department-prefixed convention", () => {
    for (const [src, dept] of [
      [GOVERNANCE_SOURCE, "governance"], [OBJECTIVES_SOURCE, "objectives"],
      [MARKETING_SOURCE, "marketing"], [PROCUREMENT_SOURCE, "procurement"],
      [ASSETS_SOURCE, "assets"], [LEGAL_SOURCE, "legal"], [PROVIDERS_SOURCE, "providers"],
    ] as const) {
      expect(src.startsWith(`${dept}.`), src).toBe(true);
    }
  });
});
