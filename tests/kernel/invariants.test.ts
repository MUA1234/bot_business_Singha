/**
 * Kernel invariants — behavioural tests (R1 checkpoint 2).
 *
 * Covers the owner's approval conditions: the AI may not invent facts, recommendations must
 * cite evidence, the zero-evidence prohibition holds, model facts unsupported by recorded
 * evidence are rejected, and cross-company data never mixes.
 */
import { describe, it, expect } from "vitest";
import {
  InvariantViolation,
  assertHasEvidence,
  assertSameCompany,
  assertInterpretationGrounded,
  unsupportedClaims,
  assertActionRegistered,
  assertInternalOnly,
  assertDeadlineProvenance,
  assertEvidenceWellFormed,
} from "@/kernel/invariants";
import type { DomainAction, EvidenceRef, Interpretation, Observation } from "@/kernel/types";

const CO_A = "11111111-1111-1111-1111-111111111111";
const CO_B = "22222222-2222-2222-2222-222222222222";

const ev = (table: string, id: string): EvidenceRef => ({
  sourceTable: table,
  sourceId: id,
  facts: { days_overdue: 47 },
  origin: "detector",
});

const observation = (over: Partial<Observation> = {}): Observation => ({
  companyId: CO_A,
  department: "finance",
  kind: "receivable_overdue",
  subjectRef: { table: "customer_invoices", id: "inv-1" },
  evidence: [ev("customer_invoices", "inv-1")],
  facts: { days_overdue: 47 },
  detectedAt: "2026-09-02T00:00:00.000Z",
  identityKey: `${CO_A}:receivable_overdue:inv-1:2026-09-02`,
  ...over,
});

describe("INV-1 — zero-evidence prohibition", () => {
  it("refuses an empty evidence set", () => {
    expect(() => assertHasEvidence([], "recommended")).toThrow(InvariantViolation);
  });

  it("names the state it refused, so the failure is diagnosable", () => {
    expect(() => assertHasEvidence([], "awaiting_approval")).toThrow(/awaiting_approval/);
  });

  it("accepts a single evidence reference", () => {
    expect(() => assertHasEvidence([ev("customer_invoices", "inv-1")], "recommended")).not.toThrow();
  });
});

describe("INV-2 — cross-company isolation", () => {
  it("refuses evidence belonging to another company", () => {
    expect(() => assertSameCompany(CO_A, [CO_A, CO_B])).toThrow(InvariantViolation);
  });

  it("reports both companies in the error rather than failing silently", () => {
    try {
      assertSameCompany(CO_A, [CO_B]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toContain(CO_A);
      expect((e as Error).message).toContain(CO_B);
    }
  });

  it("accepts evidence entirely within one company", () => {
    expect(() => assertSameCompany(CO_A, [CO_A, CO_A])).not.toThrow();
  });

  it("accepts an item with no evidence at this check (INV-1 owns that rule)", () => {
    expect(() => assertSameCompany(CO_A, [])).not.toThrow();
  });
});

describe("INV-3 — the AI may not invent business facts", () => {
  const evidence = [ev("customer_invoices", "inv-1"), ev("payments", "pay-9")];

  const interp = (statements: Interpretation["statements"]): Interpretation => ({
    source: "fixture",
    status: "ok",
    confidence: 0.9,
    statements,
  });

  it("accepts a claim cited to recorded evidence", () => {
    const i = interp([
      { claim: "invoice is 47 days overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] },
    ]);
    expect(unsupportedClaims(i, evidence)).toEqual([]);
    expect(() => assertInterpretationGrounded(i, evidence)).not.toThrow();
  });

  it("rejects a claim citing nothing at all", () => {
    const i = interp([{ claim: "the customer is unhappy", supportedBy: [] }]);
    expect(unsupportedClaims(i, evidence)).toEqual(["the customer is unhappy"]);
    expect(() => assertInterpretationGrounded(i, evidence)).toThrow(InvariantViolation);
  });

  it("rejects a claim citing evidence the item does not hold — a fabricated citation", () => {
    const i = interp([
      { claim: "there is a dispute on file", supportedBy: [{ sourceTable: "legal_matters", sourceId: "m-77" }] },
    ]);
    expect(() => assertInterpretationGrounded(i, evidence)).toThrow(/not supported by recorded evidence/i);
  });

  it("rejects the whole interpretation when only one claim of several is fabricated", () => {
    const i = interp([
      { claim: "invoice is overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] },
      { claim: "the customer intends to default", supportedBy: [] },
    ]);
    expect(unsupportedClaims(i, evidence)).toHaveLength(1);
    expect(() => assertInterpretationGrounded(i, evidence)).toThrow(InvariantViolation);
  });

  it("does not accept a citation that merely matches a table with the wrong row", () => {
    const i = interp([
      { claim: "another invoice is overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-999" }] },
    ]);
    expect(() => assertInterpretationGrounded(i, evidence)).toThrow(InvariantViolation);
  });
});

describe("INV-4 / INV-5 — only registered, internal-only actions", () => {
  const catalogue: DomainAction[] = [
    {
      id: "ops.task.create_internal",
      department: "operations",
      capability: "operations.task.manage",
      authorityFloor: "automatic",
      reversible: true,
      automaticSafe: true,
      internalOnly: true,
      description: "create an internal task",
    },
  ];

  it("resolves a registered action", () => {
    expect(assertActionRegistered("ops.task.create_internal", catalogue).id).toBe("ops.task.create_internal");
  });

  it("refuses an action the catalogue does not contain — the AI cannot invent one", () => {
    expect(() => assertActionRegistered("finance.payment.send", catalogue)).toThrow(/not in the registered catalogue/);
  });

  it("refuses an action that is not internal-only", () => {
    const external = { ...catalogue[0]!, id: "crm.message.send", internalOnly: false as unknown as true };
    expect(() => assertInternalOnly(external)).toThrow(/internal-only/);
  });

  it("accepts an internal-only action", () => {
    expect(() => assertInternalOnly(catalogue[0]!)).not.toThrow();
  });
});

describe("INV-6 — a deadline may not be invented (owner decision R1-D-4)", () => {
  it("accepts no deadline at all — null is the honest answer", () => {
    expect(() => assertDeadlineProvenance(observation({ businessDeadline: null }))).not.toThrow();
  });

  it("accepts a deadline sourced from evidence", () => {
    expect(() =>
      assertDeadlineProvenance(observation({ businessDeadline: { at: "2026-09-09T00:00:00.000Z", source: "evidence" } })),
    ).not.toThrow();
  });

  it("accepts a deadline sourced from policy", () => {
    expect(() =>
      assertDeadlineProvenance(observation({ businessDeadline: { at: "2026-09-09T00:00:00.000Z", source: "policy" } })),
    ).not.toThrow();
  });

  it("refuses a deadline with an unrecognised provenance", () => {
    const bad = observation({
      businessDeadline: { at: "2026-09-09T00:00:00.000Z", source: "guess" as unknown as "evidence" },
    });
    expect(() => assertDeadlineProvenance(bad)).toThrow(/provenance/i);
  });

  it("refuses a claimed provenance with no date", () => {
    const bad = observation({ businessDeadline: { at: "", source: "policy" } });
    expect(() => assertDeadlineProvenance(bad)).toThrow(InvariantViolation);
  });
});

describe("INV-7 — evidence must be well formed", () => {
  it("refuses a reference with no source table", () => {
    expect(() => assertEvidenceWellFormed([{ sourceTable: "", sourceId: "x", facts: {} }])).toThrow(/source table/i);
  });

  it("refuses a reference with no row id", () => {
    expect(() => assertEvidenceWellFormed([{ sourceTable: "t", sourceId: "  ", facts: {} }])).toThrow(/row id/i);
  });

  it("refuses evidence claiming a model origin — a model may cite evidence, never create it", () => {
    const bad = [{ sourceTable: "t", sourceId: "1", facts: {}, origin: "model" as unknown as "detector" }];
    expect(() => assertEvidenceWellFormed(bad)).toThrow(/never create/i);
  });

  it("accepts detector and human origins", () => {
    expect(() =>
      assertEvidenceWellFormed([
        { sourceTable: "t", sourceId: "1", facts: {}, origin: "detector" },
        { sourceTable: "t", sourceId: "2", facts: {}, origin: "human" },
      ]),
    ).not.toThrow();
  });
});
