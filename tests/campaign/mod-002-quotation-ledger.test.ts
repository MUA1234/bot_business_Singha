/**
 * MOD-002 — customer-facing model calls recorded in the cost ledger.
 *
 * The highest-volume AI surface in the product is the WhatsApp order-intake turn.
 * Every call, success or failure, must produce an ai_runs row so that AI spend and
 * failure rates are complete. The requirement is enforced at the function boundary:
 * runQuotationTurn now requires a CostLedger and records every run.
 */
import { describe, it, expect } from "vitest";
import { runQuotationTurn, runPolicyRoutedQuotationTurn, QUOTATION_PROMPT_VERSION } from "@/ai/quotation";
import { ModelPolicyExecutor, ModelPolicyRouter, ModelProviderRegistry } from "@/ai/model-policy-router";
import type { CompletionTransport, AiRunRecord, CostLedger } from "@/ai/gateway";

const COMPANY = "11111111-1111-1111-1111-111111111111";

function ledger() {
  const runs: AiRunRecord[] = [];
  const l: CostLedger = { record: (r) => void runs.push(r) };
  return { l, runs };
}

function say(text: string, costUsd = "0.0001"): CompletionTransport {
  return {
    async complete() {
      return { text, usage: { input_tokens: 12, output_tokens: 8 }, cost_usd: costUsd };
    },
  };
}

function fail(message: string): CompletionTransport {
  return {
    async complete() {
      throw new Error(message);
    },
  };
}

describe("MOD-002 — runQuotationTurn requires a CostLedger", () => {
  it("records a successful customer turn", async () => {
    const { l, runs } = ledger();
    const reply = JSON.stringify({ reply: "Thanks! What is your delivery address?", items: [], ready_to_quote: false });
    const r = await runQuotationTurn(say(reply), { message: "Hi, I need boxes", state: {} }, l);
    expect(r.ok).toBe(true);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.route).toBe("quotation");
    expect(run.model).toBeTruthy();
    expect(run.prompt_version).toBe(QUOTATION_PROMPT_VERSION);
    expect(run.input_tokens).toBe(12);
    expect(run.output_tokens).toBe(8);
    expect(run.cost_usd).toBe("0.0001");
    expect(run.validation_ok).toBe(true);
    expect(run.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("records a validation failure, not silently dropping it", async () => {
    const { l, runs } = ledger();
    const r = await runQuotationTurn(say("{ not json "), { message: "Hi", state: {} }, l);
    expect(r.ok).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.validation_ok).toBe(false);
    expect(runs[0]!.route).toBe("quotation");
  });

  it("records a transport failure", async () => {
    const { l, runs } = ledger();
    const r = await runQuotationTurn(fail("timeout"), { message: "Hi", state: {} }, l);
    expect(r.ok).toBe(false);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.validation_ok).toBe(false);
    expect(runs[0]!.latency_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("MOD-002 — runPolicyRoutedQuotationTurn records through the policy executor", () => {
  it("records the selected model and cost to the ledger", async () => {
    const { l, runs } = ledger();
    const registry = new ModelProviderRegistry([{
      candidate: {
        provider: "openai",
        model: "gpt-5.6-sol",
        tasks: ["quotation"],
        estimatedCostUsd: "0.02",
        latencyMs: 30_000,
      },
      transport: say(JSON.stringify({ reply: "Got it. How many?", items: [] }), "0.015"),
    }]);
    const executor = new ModelPolicyExecutor(registry, new ModelPolicyRouter(registry.candidates()), {
      async recordAttempt() {},
    });

    const r = await runPolicyRoutedQuotationTurn(
      executor,
      {
        message: "I need steel beams",
        state: {},
        companyId: COMPANY,
        logicalRequestId: "req-1",
        budgetRemainingUsd: "1.00",
      },
      l,
    );

    expect(r.ok).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.route).toBe("quotation");
    expect(runs[0]!.company_id).toBe(COMPANY);
    expect(runs[0]!.cost_usd).toBe("0.015");
    expect(runs[0]!.validation_ok).toBe(true);
    expect(runs[0]!.correlation_id).toBe("req-1");
  });

  it("records a policy rejection (budget exceeded) as a run", async () => {
    const { l, runs } = ledger();
    const registry = new ModelProviderRegistry([]);
    const executor = new ModelPolicyExecutor(registry, new ModelPolicyRouter(registry.candidates()), {
      async recordAttempt() {},
    });

    const r = await runPolicyRoutedQuotationTurn(
      executor,
      {
        message: "I need steel beams",
        state: {},
        companyId: COMPANY,
        logicalRequestId: "req-2",
        budgetRemainingUsd: "0.00",
      },
      l,
    );

    expect(r.ok).toBe(false);
    // The policy executor returns a rejection reason without a model call; the ledger records
    // the attempt made by runPolicyRoutedQuotationTurn itself.
    expect(runs).toHaveLength(1);
    expect(runs[0]!.company_id).toBe(COMPANY);
    expect(runs[0]!.validation_ok).toBe(false);
  });
});
