/**
 * Departmental observation adapters — behavioural tests (R1 checkpoint 3, KRN-002).
 *
 * All five departments, the common contract, the safety rules, and the ingest decisions for
 * duplicate, out-of-order, stale, resolved, malformed and failing detectors.
 */
import { describe, it, expect } from "vitest";
import {
  detectFinanceObservations, FINANCE_SOURCE,
  detectWorkforceObservations, WORKFORCE_SOURCE,
  detectOperationsObservations, OPERATIONS_SOURCE,
  detectCrmObservations, CRM_SOURCE,
  detectSystemHealthObservations, SYSTEM_SOURCE,
  OBSERVATION_SOURCES, specFor,
} from "@/kernel/adapters";
import type { FinanceScanInput } from "@/kernel/adapters/finance";
import type { WorkforceScanInput } from "@/kernel/adapters/workforce";
import type { OperationsScanInput } from "@/kernel/adapters/operations";
import type { CrmScanInput } from "@/kernel/adapters/crm";
import type { SystemHealthInput } from "@/kernel/adapters/system-health";
import { assertObservationSafe, ObservationRejected, type Observation } from "@/kernel/observation";
import { ingestObservation, runSource, summarise, type ExistingItem } from "@/kernel/ingest";

const CO_A = "11111111-1111-1111-1111-111111111111";
const CO_B = "22222222-2222-2222-2222-222222222222";
const CORR = "corr-1";
const NOW = new Date("2026-09-02T09:00:00.000Z");

const financeInput = (companyId = CO_A): FinanceScanInput => ({
  companyId, correlationId: CORR, now: NOW,
  invoices: [{
    id: "inv-1", due_date: "2026-05-01", outstanding: "480000", currency: "LKR",
    updated_at: "2026-09-01T00:00:00.000Z", status: "open",
  }],
});

const workforceInput = (companyId = CO_A): WorkforceScanInput => ({
  companyId, correlationId: CORR, now: NOW,
  capacities: [{
    membershipId: "mem-1", status: "overloaded" as const, utilizationPct: 135,
    snapshotId: "snap-1", capturedAt: "2026-09-01T00:00:00.000Z",
  }],
});

const operationsInput = (companyId = CO_A): OperationsScanInput => ({
  companyId, correlationId: CORR, now: NOW,
  tasks: [{
    id: "task-1", title: "Fix the thing", status: "in_progress",
    dueDate: "2026-08-01", lastCheckInAt: "2026-09-01T00:00:00.000Z", estimateHours: 4 as number | null,
    updatedAt: "2026-09-01T00:00:00.000Z",
  }],
});

const crmInput = (companyId = CO_A): CrmScanInput => ({
  companyId, correlationId: CORR, now: NOW,
  conversations: [{
    id: "conv-1", last_inbound_at: "2026-09-01T09:00:00.000Z", last_outbound_at: null, status: "open",
  }],
});

const systemInput = (companyId = CO_A): SystemHealthInput => ({
  companyId, correlationId: CORR, now: NOW,
  oldestPendingOutboxMinutes: 240,
  failedOutboxCount: 3,
  ledger: { imbalancedJournals: 1, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
  providerFailures: 4,
  missingConfigKeys: ["OPENAI_API_KEY"],
  sampledAt: "2026-09-02T08:55:00.000Z",
});

const allFive = (companyId = CO_A): Observation[] => [
  ...detectFinanceObservations(financeInput(companyId)),
  ...detectWorkforceObservations(workforceInput(companyId)),
  ...detectOperationsObservations(operationsInput(companyId)),
  ...detectCrmObservations(crmInput(companyId)),
  ...detectSystemHealthObservations(systemInput(companyId)),
];

describe("all five departments observed in ONE company", () => {
  it("produces at least one observation per department", () => {
    const obs = allFive();
    const depts = new Set(obs.map((o) => o.department));
    expect(depts).toEqual(new Set(["finance", "workforce", "operations", "crm", "system"]));
  });

  it("every observation satisfies the common contract", () => {
    for (const o of allFive()) {
      expect(() => assertObservationSafe(o, { companyId: CO_A })).not.toThrow();
      expect(o.companyId).toBe(CO_A);
      expect(o.observationSource).toBeTruthy();
      expect(o.subjectRef.table).toBeTruthy();
      expect(o.subjectRef.id).toBeTruthy();
      expect(o.evidence.length).toBeGreaterThan(0);
      expect(o.evidenceAt).toBeTruthy();
      expect(o.detectedAt).toBeTruthy();
      expect(["critical", "warn", "info"]).toContain(o.severity);
      expect(o.confidence).toBeGreaterThanOrEqual(0);
      expect(o.confidence).toBeLessThanOrEqual(1);
      expect(o.identityKey).toContain(CO_A);
      expect(["fresh", "aging", "stale", "unknown"]).toContain(o.freshness);
      expect(o.suggestedActionCategory).toBeTruthy();
      expect(o.authorityClass).toBeTruthy();
      expect(o.correlationId).toBe(CORR);
    }
  });

  it("every registered source is in the registry with a cadence", () => {
    // R2A: twelve managed domains, one registered source each.
    expect(OBSERVATION_SOURCES).toHaveLength(12);
    for (const s of [FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE]) {
      const spec = specFor(s);
      expect(spec, `${s} is not registered`).not.toBeNull();
      expect(spec!.supportsScheduled).toBe(true);
      expect(spec!.cadenceSeconds).toBeGreaterThanOrEqual(60);
    }
  });
});

describe("two companies stay isolated", () => {
  it("identical conditions in two companies produce distinct identity keys", () => {
    const a = allFive(CO_A);
    const b = allFive(CO_B);
    const keysA = new Set(a.map((o) => o.identityKey));
    for (const o of b) expect(keysA.has(o.identityKey)).toBe(false);
  });

  it("an observation scanned for company A is REFUSED under company B's context", () => {
    const [o] = allFive(CO_A);
    expect(() => assertObservationSafe(o!, { companyId: CO_B })).toThrow(/company identity/i);
  });

  it("company identity may not be taken from a payload — only from the scan context", () => {
    const forged: Observation = { ...allFive(CO_A)[0]!, companyId: CO_B };
    const d = ingestObservation(forged, { companyId: CO_A }, null);
    expect(d.action).toBe("reject");
    if (d.action === "reject") expect(d.code).toBe("unresolved_company");
  });
});

describe("minimum safe summary — no sensitive payload is copied", () => {
  it("finance carries a magnitude band, never the amount or the customer", () => {
    const [o] = detectFinanceObservations(financeInput());
    expect(JSON.stringify(o!.facts)).not.toContain("480000");
    expect(o!.facts.outstanding_magnitude).toBe("100k-1m");
  });

  it("CRM carries a waiting band, never message content or a phone number", () => {
    const [o] = detectCrmObservations(crmInput());
    const blob = JSON.stringify([o!.facts, o!.evidence, o!.summary]);
    expect(blob).not.toMatch(/\+94|body|transcript|message/i);
    expect(o!.facts.waiting_band).toBe("24-72h");
  });

  it("operations carries the condition, never the task title", () => {
    const [o] = detectOperationsObservations(operationsInput());
    expect(JSON.stringify([o!.facts, o!.evidence])).not.toContain("Fix the thing");
  });

  it("workforce carries a utilisation band against a MEMBERSHIP, never a person's details", () => {
    const [o] = detectWorkforceObservations(workforceInput());
    expect(o!.subjectRef.table).toBe("memberships");
    expect(o!.facts.utilisation_band).toBe("120%+");
  });

  it("system health carries config KEY NAMES only, never values", () => {
    const [o] = detectSystemHealthObservations(systemInput());
    expect(o!.facts.missing_config_keys).toEqual(["OPENAI_API_KEY"]);
    expect(JSON.stringify(o!.facts)).not.toMatch(/sk-|secret|password|token/i);
  });

  it("a sensitive fact key is REFUSED outright", () => {
    for (const key of ["customer_name", "phone", "salary", "api_key", "bank_account"]) {
      const bad: Observation = { ...allFive()[0]!, facts: { [key]: "x" } };
      expect(() => assertObservationSafe(bad, { companyId: CO_A }), key).toThrow(ObservationRejected);
    }
  });

  it("a sensitive key hidden inside EVIDENCE facts is refused too", () => {
    const base = allFive()[0]!;
    const bad: Observation = {
      ...base,
      evidence: [{ ...base.evidence[0]!, facts: { customer_email: "a@b.c" } }],
    };
    expect(() => assertObservationSafe(bad, { companyId: CO_A })).toThrow(/may not be copied/i);
  });
});

describe("resolved and stale source records do not become new work", () => {
  it("a settled invoice produces nothing", () => {
    for (const status of ["paid", "settled", "void", "cancelled", "written_off"]) {
      const input = financeInput();
      input.invoices[0]!.status = status;
      expect(detectFinanceObservations(input)).toEqual([]);
    }
  });

  it("an invoice with nothing outstanding produces nothing", () => {
    const input = financeInput();
    input.invoices[0]!.outstanding = "0";
    expect(detectFinanceObservations(input)).toEqual([]);
  });

  it("a completed or cancelled task produces nothing", () => {
    for (const status of ["completed", "cancelled"] as const) {
      const input = operationsInput();
      input.tasks[0]!.status = status;
      expect(detectOperationsObservations(input)).toEqual([]);
    }
  });

  it("an answered conversation produces nothing", () => {
    const input = crmInput();
    input.conversations[0]!.last_outbound_at = "2026-09-01T10:00:00.000Z";
    expect(detectCrmObservations(input)).toEqual([]);
  });

  it("a closed or opted-out conversation produces nothing", () => {
    for (const status of ["closed", "resolved", "opted_out", "archived"]) {
      const input = crmInput();
      input.conversations[0]!.status = status;
      expect(detectCrmObservations(input)).toEqual([]);
    }
  });

  it("healthy system state produces nothing — the queue is exception-led", () => {
    const input = systemInput();
    Object.assign(input, {
      oldestPendingOutboxMinutes: 0, failedOutboxCount: 0, providerFailures: 0,
      missingConfigKeys: [], ledger: { imbalancedJournals: 0, headerLineMismatch: 0, orphanedLines: 0, lockedPeriodPostings: 0 },
    });
    expect(detectSystemHealthObservations(input)).toEqual([]);
  });

  it("a STALE observation with no existing item is skipped, not queued", () => {
    const o: Observation = { ...allFive()[0]!, freshness: "stale" };
    const d = ingestObservation(o, { companyId: CO_A }, null);
    expect(d).toEqual({ action: "skip", reason: "stale_source" });
  });
});

describe("duplicate and out-of-order observations", () => {
  const base = () => allFive()[0]!;

  it("a duplicate REUSES the existing item and never creates a second", () => {
    const o = base();
    const existing: ExistingItem = {
      id: "item-1", state: "observed", severity: "info", priority: o.priority, evidenceAt: "2026-08-01T00:00:00.000Z",
    };
    const d = ingestObservation(o, { companyId: CO_A }, existing);
    expect(d.action).toBe("reuse");
    if (d.action === "reuse") {
      expect(d.itemId).toBe("item-1");
      expect(d.refreshedFields).toContain("severity");
    }
  });

  it("an unchanged duplicate is skipped entirely — no churn", () => {
    const o = base();
    const existing: ExistingItem = {
      id: "item-1", state: "observed", severity: o.severity, priority: o.priority, evidenceAt: o.evidenceAt,
    };
    expect(ingestObservation(o, { companyId: CO_A }, existing)).toEqual({
      action: "skip", reason: "unchanged", itemId: "item-1",
    });
  });

  it("an OUT-OF-ORDER observation never moves an item backwards", () => {
    const o = base();
    const existing: ExistingItem = {
      id: "item-1", state: "monitoring", severity: "critical", priority: "critical",
      evidenceAt: "2026-09-02T08:00:00.000Z", // newer than the observation
    };
    const older: Observation = { ...o, evidenceAt: "2026-08-30T00:00:00.000Z" };
    expect(ingestObservation(older, { companyId: CO_A }, existing)).toEqual({
      action: "skip", reason: "out_of_order", itemId: "item-1",
    });
  });

  it("a TERMINAL item is not reopened by another sighting in the same window", () => {
    for (const state of ["verified", "rejected", "dismissed", "expired"]) {
      const d = ingestObservation(base(), { companyId: CO_A }, { id: "item-1", state });
      expect(d).toEqual({ action: "skip", reason: "already_terminal", itemId: "item-1" });
    }
  });

  it("the identity key is stable across re-scans in the same window", () => {
    const a = detectFinanceObservations(financeInput())[0]!;
    const b = detectFinanceObservations(financeInput())[0]!;
    expect(a.identityKey).toBe(b.identityKey);
  });

  it("a new occurrence window yields a NEW key, so recurring work is not lost", () => {
    const day1 = detectFinanceObservations({ ...financeInput(), now: new Date("2026-09-02T09:00:00Z") })[0]!;
    const day2 = detectFinanceObservations({ ...financeInput(), now: new Date("2026-09-03T09:00:00Z") })[0]!;
    expect(day1.identityKey).not.toBe(day2.identityKey);
  });

  it("two different conditions on the SAME task are two items", () => {
    const input = operationsInput();
    input.tasks[0]!.estimateHours = null; // overdue AND missing_estimate
    const obs = detectOperationsObservations(input);
    expect(obs.length).toBeGreaterThan(1);
    expect(new Set(obs.map((o) => o.identityKey)).size).toBe(obs.length);
  });
});

describe("missing, contradictory and malformed evidence fails closed", () => {
  it("an observation with no evidence is REJECTED", () => {
    const bad: Observation = { ...allFive()[0]!, evidence: [] };
    const d = ingestObservation(bad, { companyId: CO_A }, null);
    expect(d.action).toBe("reject");
    if (d.action === "reject") expect(d.code).toBe("missing_evidence");
  });

  it("evidence with no row id is REJECTED", () => {
    const base = allFive()[0]!;
    const bad: Observation = { ...base, evidence: [{ ...base.evidence[0]!, sourceId: "  " }] };
    const d = ingestObservation(bad, { companyId: CO_A }, null);
    expect(d.action).toBe("reject");
    if (d.action === "reject") expect(d.code).toBe("malformed_evidence");
  });

  it("a contradictory confidence is REJECTED", () => {
    for (const confidence of [-0.1, 1.5, NaN]) {
      const bad: Observation = { ...allFive()[0]!, confidence };
      const d = ingestObservation(bad, { companyId: CO_A }, null);
      expect(d.action).toBe("reject");
    }
  });

  it("an unsourced business deadline is REJECTED (R1-D-4)", () => {
    const bad: Observation = {
      ...allFive()[0]!,
      businessDeadline: { at: "2026-09-09T00:00:00.000Z", source: "guess" as unknown as "policy" },
    };
    const d = ingestObservation(bad, { companyId: CO_A }, null);
    expect(d.action).toBe("reject");
    if (d.action === "reject") expect(d.code).toBe("invented_deadline");
  });

  it("a missing subject reference is REJECTED", () => {
    const bad: Observation = { ...allFive()[0]!, subjectRef: { table: "", id: "" } };
    const d = ingestObservation(bad, { companyId: CO_A }, null);
    expect(d.action).toBe("reject");
  });
});

describe("detector failure, retry and malformed output", () => {
  const ok = () => detectFinanceObservations(financeInput());

  it("a THROWING detector reports the department UNOBSERVED, never 'nothing found'", () => {
    const out = runSource(FINANCE_SOURCE, "finance", () => { throw new Error("connection refused"); },
      { companyId: CO_A }, () => null);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.unobserved).toBe(true);
      expect(out.reason).toContain("connection refused");
    }
  });

  it("a failed sweep is NEVER summarised as a complete all-clear", () => {
    const outcomes = [
      runSource(FINANCE_SOURCE, "finance", () => { throw new Error("down"); }, { companyId: CO_A }, () => null),
      runSource(OPERATIONS_SOURCE, "operations", () => detectOperationsObservations(operationsInput()), { companyId: CO_A }, () => null),
    ];
    const s = summarise(outcomes);
    expect(s.completeSweep).toBe(false);
    expect(s.unobservedDepartments).toContain("finance");
  });

  it("a clean sweep IS reported complete", () => {
    const s = summarise([runSource(FINANCE_SOURCE, "finance", ok, { companyId: CO_A }, () => null)]);
    expect(s.completeSweep).toBe(true);
    expect(s.unobservedDepartments).toEqual([]);
    expect(s.created).toBe(1);
  });

  it("RETRY after a failure succeeds without duplicating the item", () => {
    let attempt = 0;
    const flaky = () => {
      attempt++;
      if (attempt === 1) throw new Error("transient");
      return ok();
    };
    const first = runSource(FINANCE_SOURCE, "finance", flaky, { companyId: CO_A }, () => null);
    expect(first.ok).toBe(false);

    // The retry sees the item the first successful pass would have created.
    const created: ExistingItem = { id: "item-1", state: "observed", severity: "warn", priority: "high", evidenceAt: ok()[0]!.evidenceAt };
    const second = runSource(FINANCE_SOURCE, "finance", flaky, { companyId: CO_A }, () => created);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.decisions.every((d) => d.action !== "create")).toBe(true);
    }
  });

  it("MALFORMED detector output is a failure, not an empty result", () => {
    const out = runSource(FINANCE_SOURCE, "finance", (() => "not an array") as unknown as () => Observation[],
      { companyId: CO_A }, () => null);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toMatch(/did not return an array/);
  });

  it("a non-object entry is rejected without poisoning the rest of the batch", () => {
    const out = runSource(FINANCE_SOURCE, "finance",
      () => [null as unknown as Observation, ...ok()], { companyId: CO_A }, () => null);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.decisions.filter((d) => d.action === "reject")).toHaveLength(1);
      expect(out.decisions.filter((d) => d.action === "create")).toHaveLength(1);
    }
  });
});

describe("no detector performs the action, and department limits hold", () => {
  it("CRM only ever suggests an internal category, never an automatic send (R1-D-7)", () => {
    for (const o of detectCrmObservations(crmInput())) {
      expect(["chase", "review"]).toContain(o.suggestedActionCategory);
      expect(o.authorityClass).not.toBe("automatic");
    }
  });

  it("finance never suggests posting, settling, approving or moving money", () => {
    for (const o of detectFinanceObservations(financeInput())) {
      expect(["chase", "review", "escalate"]).toContain(o.suggestedActionCategory);
      expect(o.authorityClass).not.toBe("automatic");
    }
  });

  it("an observation carries a suggested CATEGORY, never an executable action id", () => {
    for (const o of allFive()) {
      expect(o.suggestedActionCategory).not.toMatch(/\./); // catalogue ids look like "ops.task.create"
    }
  });
});
