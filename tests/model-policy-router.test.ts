import { describe, expect, it } from "vitest";
import { ModelPolicyRouter } from "@/ai/model-policy-router";

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