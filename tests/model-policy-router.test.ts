import { describe, expect, it } from "vitest";
import type { CompletionTransport } from "@/ai/gateway";
import {
  ModelPolicyExecutor,
  ModelPolicyRouter,
  ModelProviderRegistry,
} from "@/ai/model-policy-router";
import { runPolicyRoutedQuotationTurn } from "@/ai/quotation";

describe("MOD-003 model policy router", () => {
  it("selects the cheapest healthy approved provider within the company budget", () => {
    const router = new ModelPolicyRouter([
      { provider: "primary", model: "p-small", tasks: ["quotation"], estimatedCostUsd: "0.01", latencyMs: 500 },
      { provider: "fallback", model: "f-small", tasks: ["quotation"], estimatedCostUsd: "0.02", latencyMs: 300 },
    ]);

    expect(router.select({ companyId: "co", task: "quotation", budgetRemainingUsd: "0.015" })).toEqual({
      ok: true, provider: "primary", model: "p-small", review: "none",
    });
  });

  it("fails closed on exhausted budget and selects a healthy fallback after provider failure", () => {
    const router = new ModelPolicyRouter([
      { provider: "primary", model: "p", tasks: ["management"], estimatedCostUsd: "0.02", latencyMs: 100 },
      { provider: "fallback", model: "f", tasks: ["management"], estimatedCostUsd: "0.03", latencyMs: 300 },
    ]);

    expect(router.select({ companyId: "co", task: "management", budgetRemainingUsd: "0.01" })).toEqual({
      ok: false, reason: "budget_exceeded",
    });
    router.recordFailure("primary");
    expect(router.select({ companyId: "co", task: "management", budgetRemainingUsd: "1" })).toMatchObject({
      ok: true, provider: "fallback", model: "f",
    });
  });
});

describe("MOD-003 policy execution", () => {
  it("falls back with one logical request identity and records both attempts", async () => {
    const attempts: unknown[] = [];
    const failing: CompletionTransport = { complete: async () => { throw new Error("timeout"); } };
    const succeeding: CompletionTransport = {
      complete: async () => ({ text: "{}", usage: { input_tokens: 2, output_tokens: 3 }, cost_usd: "0.02" }),
    };
    const registry = new ModelProviderRegistry([
      { candidate: { provider: "primary", model: "p", tasks: ["quotation"], estimatedCostUsd: "0.01", latencyMs: 10 }, transport: failing },
      { candidate: { provider: "fallback", model: "f", tasks: ["quotation"], estimatedCostUsd: "0.02", latencyMs: 20 }, transport: succeeding },
    ]);
    const executor = new ModelPolicyExecutor(
      registry,
      new ModelPolicyRouter(registry.candidates()),
      { recordAttempt: (attempt) => { attempts.push(attempt); } },
    );

    const result = await executor.execute({
      logicalRequestId: "logical-1",
      selection: { companyId: "co", task: "quotation", budgetRemainingUsd: "1" },
      completion: { system: "system", user: "user", maxTokens: 10 },
    });

    expect(result).toMatchObject({ ok: true, attempts: 2, selection: { provider: "fallback", model: "f" } });
    expect(attempts).toEqual([
      expect.objectContaining({ logicalRequestId: "logical-1", provider: "primary", attempt: 1, outcome: "failed" }),
      expect.objectContaining({ logicalRequestId: "logical-1", provider: "fallback", attempt: 2, outcome: "succeeded" }),
    ]);
  });

  it("routes quotation analysis through policy without allowing the attempt to persist an effect", async () => {
    const transport: CompletionTransport = {
      complete: async () => ({
        text: JSON.stringify({ reply: "What is the delivery address?", items: [], ready_to_quote: false }),
        usage: { input_tokens: 1, output_tokens: 2 }, cost_usd: "0.01",
      }),
    };
    const registry = new ModelProviderRegistry([
      { candidate: { provider: "approved", model: "q", tasks: ["quotation"], estimatedCostUsd: "0.01", latencyMs: 1 }, transport },
    ]);
    const executor = new ModelPolicyExecutor(
      registry,
      new ModelPolicyRouter(registry.candidates()),
      { recordAttempt: () => undefined },
    );

    await expect(runPolicyRoutedQuotationTurn(executor, {
      companyId: "company", logicalRequestId: "quotation:inbound", budgetRemainingUsd: "0.01",
      message: "I need boxes", state: {},
    }, { record: () => undefined })).resolves.toMatchObject({ ok: true, turn: { reply: "What is the delivery address?" } });
  });

  it("records a fail-closed policy rejection without calling a transport", async () => {
    const attempts: unknown[] = [];
    const registry = new ModelProviderRegistry([]);
    const executor = new ModelPolicyExecutor(
      registry,
      new ModelPolicyRouter(registry.candidates()),
      { recordAttempt: (attempt) => { attempts.push(attempt); } },
    );

    await expect(executor.execute({
      logicalRequestId: "logical-budget", selection: { companyId: "co", task: "quotation", budgetRemainingUsd: "0" },
      completion: { system: "system", user: "user", maxTokens: 1 },
    })).resolves.toEqual({ ok: false, reason: "no_healthy_provider", attempts: 0 });
    expect(attempts).toEqual([expect.objectContaining({ provider: "policy", model: "unselected", errorCategory: "no_healthy_provider" })]);
  });
});