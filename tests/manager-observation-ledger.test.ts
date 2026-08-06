import { describe, it, expect } from "vitest";
import { runManagerObservation } from "@/ai/manager-observation";
import type { CompletionTransport, AiRunRecord, CostLedger } from "@/ai/gateway";

const validObservation = JSON.stringify({
  evidenceRefs: ["x"],
  involved: { people: [], customers: [], suppliers: [], vehicles: [], assets: [] },
  confirmedFacts: ["a"],
  inferredFacts: [],
  detectedTasks: [],
  impact: {},
  confidence: 0.7,
  uncertainty: null,
  missingInfo: [],
  suggestedActions: [],
  requiredAuthority: "manager_approval",
});

function transportReturning(text: string, cost = "0.0132"): CompletionTransport {
  return { complete: async () => ({ text, usage: { input_tokens: 100, output_tokens: 50 }, cost_usd: cost }) };
}
function throwingTransport(): CompletionTransport {
  return { complete: async () => { throw new Error("boom"); } };
}
function capturingLedger(): { ledger: CostLedger; runs: AiRunRecord[] } {
  const runs: AiRunRecord[] = [];
  return { ledger: { record: (r) => { runs.push(r); } }, runs };
}

describe("runManagerObservation records to the cost ledger (§WP5.2)", () => {
  it("records model, tokens, cost, route and trusted scope on success", async () => {
    const { ledger, runs } = capturingLedger();
    const res = await runManagerObservation(transportReturning(validObservation), { update: "u", companyId: "co-a", sourceEventId: "evt-9", correlationId: "cor_x" }, ledger);
    expect(res.ok).toBe(true);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.route).toBe("management");
    expect(run.cost_usd).toBe("0.0132");
    expect(run.input_tokens).toBe(100);
    expect(run.output_tokens).toBe(50);
    expect(run.validation_ok).toBe(true);
    expect(run.confidence_overall).toBe(0.7);
    expect(run.company_id).toBe("co-a");
    expect(run.source_event_id).toBe("evt-9");
    expect(run.correlation_id).toBe("cor_x");
  });

  it("records a failed validation run (still costed)", async () => {
    const { ledger, runs } = capturingLedger();
    const res = await runManagerObservation(transportReturning("{}"), { update: "u", companyId: "co-a" }, ledger);
    expect(res.ok).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.validation_ok).toBe(false);
  });

  it("records a transport error as a zero-cost run", async () => {
    const { ledger, runs } = capturingLedger();
    const res = await runManagerObservation(throwingTransport(), { update: "u", companyId: "co-a" }, ledger);
    expect(res.ok).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.cost_usd).toBe("0");
  });

  it("works without a ledger (back-compatible)", async () => {
    const res = await runManagerObservation(transportReturning(validObservation), { update: "u", companyId: "co-a" });
    expect(res.ok).toBe(true);
    expect(res.run.route).toBe("management");
  });
});
