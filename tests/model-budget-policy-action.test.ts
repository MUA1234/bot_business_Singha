import { beforeEach, describe, expect, it, vi } from "vitest";
import { saveModelBudgetPolicy } from "@/app/app/admin/model-budgets/actions";
import { requireCapability } from "@/lib/access";
import { supabaseRpcClient } from "@/lib/supabase/read";
import { loadAiTaskBudget } from "@/db/consumer-store";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

vi.mock("@/lib/access", () => ({
  requireCapability: vi.fn(),
}));

vi.mock("@/lib/supabase/read", () => ({
  supabaseRpcClient: vi.fn(),
}));

describe("model budget policy action", () => {
  const rpc = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    rpc.mockReset();
    vi.mocked(requireCapability).mockResolvedValue({
      companyId: "company-1",
      userId: "user-1",
      membershipId: "membership-1",
      status: "active",
      roleKeys: ["owner_management"],
    } as any);
    vi.mocked(supabaseRpcClient).mockReturnValue({ rpc } as any);
  });

  it("uses the authenticated RPC client and ignores submitted company identifiers", async () => {
    rpc.mockResolvedValue({ error: null });

    const form = new FormData();
    form.set("task", "extraction");
    form.set("maxCostUsd", "12.50");
    form.set("companyId", "intruder-company");
    form.set("version", "0");

    const result = await saveModelBudgetPolicy({} as any, form);

    expect(result).toEqual({ ok: "Model budget configured." });
    expect(requireCapability).toHaveBeenCalledWith("ai.model_budget.manage");
    expect(supabaseRpcClient).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("set_ai_model_budget_policy", {
      p_company: "company-1",
      p_task: "extraction",
      p_max_cost_usd: "12.5",
      p_active: true,
      p_expected_version: 0,
    });
  });

  it("rejects unsafe decimal strings and stale writes without mutating the budget", async () => {
    const invalids = ["1e3", "NaN", "Infinity", "-1", "1.2345678", "1,234.56", "1.234,56", "0", ""];
    for (const value of invalids) {
      const form = new FormData();
      form.set("task", "quotation");
      form.set("maxCostUsd", value);
      form.set("version", "0");
      await expect(saveModelBudgetPolicy({} as any, form)).resolves.toMatchObject({ error: expect.any(String) });
    }

    rpc.mockResolvedValue({ error: { message: "stale policy version" } });
    const stale = new FormData();
    stale.set("task", "management");
    stale.set("maxCostUsd", "4.25");
    stale.set("version", "3");
    await expect(saveModelBudgetPolicy({} as any, stale)).resolves.toEqual({ error: "This policy changed. Reload before updating it." });
  });

  it("disables the policy without mutating the amount when per-request active flag is false", async () => {
    rpc.mockResolvedValue({ error: null });
    const form = new FormData();
    form.set("task", "management");
    form.set("maxCostUsd", "4.25");
    form.set("version", "1");
    form.set("active", "false");

    await expect(saveModelBudgetPolicy({} as any, form)).resolves.toEqual({ ok: "Model budget disabled." });
    expect(rpc).toHaveBeenCalledWith("set_ai_model_budget_policy", {
      p_company: "company-1",
      p_task: "management",
      p_max_cost_usd: "4.25",
      p_active: false,
      p_expected_version: 1,
    });
  });
});

describe("model budget exact-decimal budget loader", () => {
  it("uses exact decimal arithmetic for remaining budget instead of float conversion", async () => {
    const db = {
      from(table: string) {
        if (table === "ai_model_budget_policies") {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  eq: () => ({
                    maybeSingle: async () => ({
                      data: { max_cost_usd: "0.3" },
                      error: null,
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                gte: () => ({
                  data: [{ cost_usd: "0.1" }, { cost_usd: "0.1" }, { cost_usd: "0.1" }],
                  error: null,
                }),
              }),
            }),
          }),
        };
      },
    };

    await expect(loadAiTaskBudget(db as any, "company-1", "extraction")).resolves.toBe("0");
  });
});
