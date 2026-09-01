/**
 * Interpretation adapter boundary — behavioural tests (R1 checkpoint 2, owner decision R1-D-6).
 *
 * Proves the four degraded cases the owner required to be recorded — malformed, timeout,
 * low confidence and disagreement — and that the loop continues deterministically in every
 * one of them. No live or paid model is called: the fixture adapter is deterministic.
 */
import { describe, it, expect } from "vitest";
import {
  interpretWithGuards,
  detectDisagreement,
  fixtureInterpreter,
  mayInfluenceRecommendation,
  deterministicFallback,
  LOW_CONFIDENCE_THRESHOLD,
  type InterpreterAdapter,
} from "@/kernel/interpretation";
import type { EvidenceRef, Interpretation, Observation } from "@/kernel/types";

const CO = "11111111-1111-1111-1111-111111111111";
const evidence: EvidenceRef[] = [
  { sourceTable: "customer_invoices", sourceId: "inv-1", facts: { days_overdue: 47 }, origin: "detector" },
];

const obs: Observation = {
  companyId: CO,
  department: "finance",
  kind: "receivable_overdue",
  subjectRef: { table: "customer_invoices", id: "inv-1" },
  evidence,
  facts: { days_overdue: 47 },
  detectedAt: "2026-09-02T00:00:00.000Z",
  identityKey: `${CO}:receivable_overdue:inv-1:2026-09-02`,
};

const adapterReturning = (i: Interpretation | (() => Promise<Interpretation>)): InterpreterAdapter => ({
  name: "test",
  source: "fixture",
  interpret: typeof i === "function" ? (i as () => Promise<Interpretation>) : async () => i,
});

describe("the fixture adapter is deterministic and grounded", () => {
  it("returns the same result for the same observation", async () => {
    const a = await interpretWithGuards(obs, evidence, fixtureInterpreter());
    const b = await interpretWithGuards(obs, evidence, fixtureInterpreter());
    expect(a).toEqual(b);
  });

  it("cites every claim to recorded evidence", async () => {
    const r = await interpretWithGuards(obs, evidence, fixtureInterpreter());
    expect(r.status).toBe("ok");
    expect(r.statements.length).toBeGreaterThan(0);
    for (const s of r.statements) {
      expect(s.supportedBy[0]!.sourceId).toBe("inv-1");
    }
  });

  it("an ok interpretation may influence a recommendation", async () => {
    const r = await interpretWithGuards(obs, evidence, fixtureInterpreter());
    expect(mayInfluenceRecommendation(r)).toBe(true);
  });
});

describe("degraded case — unavailable", () => {
  it("records `unavailable` when no adapter is configured", async () => {
    const r = await interpretWithGuards(obs, evidence, null);
    expect(r.status).toBe("unavailable");
    expect(r.source).toBe("none");
    expect(r.statements).toEqual([]);
    expect(r.confidence).toBe(0);
  });

  it("does not let an unavailable interpretation influence a recommendation", async () => {
    const r = await interpretWithGuards(obs, evidence, null);
    expect(mayInfluenceRecommendation(r)).toBe(false);
  });
});

describe("degraded case — timeout", () => {
  it("records `timeout` and returns zero statements when the adapter exceeds its budget", async () => {
    const slow = adapterReturning(() => new Promise<Interpretation>(() => {})); // never resolves
    const r = await interpretWithGuards(obs, evidence, slow, { budgetMs: 20 });
    expect(r.status).toBe("timeout");
    expect(r.statements).toEqual([]);
    expect(r.note).toContain("20ms");
  });

  it("the loop still gets a usable, deterministic result rather than an exception", async () => {
    const slow = adapterReturning(() => new Promise<Interpretation>(() => {}));
    await expect(interpretWithGuards(obs, evidence, slow, { budgetMs: 20 })).resolves.toBeTruthy();
  });
});

describe("degraded case — malformed", () => {
  it("records `malformed` when the adapter throws", async () => {
    const boom = adapterReturning(async () => {
      throw new Error("upstream exploded");
    });
    const r = await interpretWithGuards(obs, evidence, boom);
    expect(r.status).toBe("malformed");
    expect(r.note).toContain("upstream exploded");
  });

  it("records `malformed` for an invalid envelope", async () => {
    const bad = adapterReturning({ statements: "nope", confidence: 0.9 } as unknown as Interpretation);
    const r = await interpretWithGuards(obs, evidence, bad);
    expect(r.status).toBe("malformed");
  });

  it("records `malformed` for a confidence outside [0,1]", async () => {
    const bad = adapterReturning({ source: "fixture", status: "ok", confidence: 1.4, statements: [] });
    const r = await interpretWithGuards(obs, evidence, bad);
    expect(r.status).toBe("malformed");
    expect(r.note).toContain("1.4");
  });

  it("REJECTS a fabricated fact and discards the whole interpretation", async () => {
    const fabricating = adapterReturning({
      source: "fixture",
      status: "ok",
      confidence: 0.99,
      statements: [
        { claim: "invoice overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] },
        { claim: "the customer has filed for bankruptcy", supportedBy: [] },
      ],
    });
    const r = await interpretWithGuards(obs, evidence, fabricating);
    expect(r.status).toBe("malformed");
    expect(r.statements).toEqual([]); // the grounded claim is discarded too
    expect(r.note).toContain("bankruptcy");
  });

  it("REJECTS a citation to evidence the item does not hold", async () => {
    const fabricating = adapterReturning({
      source: "fixture",
      status: "ok",
      confidence: 0.99,
      statements: [{ claim: "a dispute exists", supportedBy: [{ sourceTable: "legal_matters", sourceId: "m-1" }] }],
    });
    const r = await interpretWithGuards(obs, evidence, fabricating);
    expect(r.status).toBe("malformed");
  });
});

describe("degraded case — low confidence", () => {
  it("records `low_confidence` below the threshold", async () => {
    const unsure = adapterReturning({
      source: "fixture",
      status: "ok",
      confidence: LOW_CONFIDENCE_THRESHOLD - 0.01,
      statements: [{ claim: "maybe overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] }],
    });
    const r = await interpretWithGuards(obs, evidence, unsure);
    expect(r.status).toBe("low_confidence");
  });

  it("keeps the statements but forbids them influencing a recommendation", async () => {
    const unsure = adapterReturning({
      source: "fixture",
      status: "ok",
      confidence: 0.2,
      statements: [{ claim: "maybe overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] }],
    });
    const r = await interpretWithGuards(obs, evidence, unsure);
    expect(r.statements).toHaveLength(1);
    expect(mayInfluenceRecommendation(r)).toBe(false);
  });

  it("accepts exactly at the threshold", async () => {
    const ok = adapterReturning({
      source: "fixture",
      status: "ok",
      confidence: LOW_CONFIDENCE_THRESHOLD,
      statements: [{ claim: "overdue", supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] }],
    });
    expect((await interpretWithGuards(obs, evidence, ok)).status).toBe("ok");
  });
});

describe("degraded case — disagreement", () => {
  const grounded = (claim: string): Interpretation => ({
    source: "fixture",
    status: "ok",
    confidence: 0.9,
    statements: [{ claim, supportedBy: [{ sourceTable: "customer_invoices", sourceId: "inv-1" }] }],
  });

  it("returns null when two interpretations agree", () => {
    expect(detectDisagreement(grounded("overdue"), grounded("overdue"))).toBeNull();
  });

  it("records `disagreement` when they conflict, and arbitrates NOTHING", () => {
    const d = detectDisagreement(grounded("overdue"), grounded("not overdue"));
    expect(d?.status).toBe("disagreement");
    expect(d?.statements).toEqual([]);
    expect(d?.confidence).toBe(0);
  });

  it("names both sides so a human can adjudicate", () => {
    const d = detectDisagreement(grounded("overdue"), grounded("not overdue"));
    expect(d?.note).toContain("overdue");
    expect(d?.note).toContain("not overdue");
  });

  it("does not compare interpretations that are not themselves ok", () => {
    expect(detectDisagreement(deterministicFallback("timeout", "x"), grounded("overdue"))).toBeNull();
  });

  it("a disagreement may not influence a recommendation", () => {
    const d = detectDisagreement(grounded("a"), grounded("b"))!;
    expect(mayInfluenceRecommendation(d)).toBe(false);
  });
});
