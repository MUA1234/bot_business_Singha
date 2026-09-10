"use server";

import Decimal from "decimal.js";
import { revalidatePath } from "next/cache";
import { requireCapability } from "@/lib/access";
import { supabaseRpcClient } from "@/lib/supabase/read";

export interface ModelBudgetState { error?: string; ok?: string }

const ALLOWED_TASKS = new Set(["extraction", "quotation", "management"]);

function parsePolicyAmount(raw: FormDataEntryValue | null): string | null {
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (!value || /[\s,]/.test(value) || /[eE]/.test(value)) return null;
  if (!/^(?:\d+\.\d+|\d+)$/.test(value)) return null;
  const dec = new Decimal(value);
  if (!dec.isFinite() || dec.lte(0) || dec.dp() > 6) return null;
  return dec.toString();
}

function parseExpectedVersion(raw: FormDataEntryValue | null): number | null {
  const value = typeof raw === "string" ? raw.trim() : String(raw ?? "").trim();
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return null;
  return Number(value);
}

export async function saveModelBudgetPolicy(_prev: ModelBudgetState, formData: FormData): Promise<ModelBudgetState> {
  let membership;
  try { membership = await requireCapability("ai.model_budget.manage"); } catch { return { error: "You do not have permission to manage model budgets." }; }

  const task = String(formData.get("task") ?? "").trim();
  if (!ALLOWED_TASKS.has(task)) return { error: "Select a valid model task." };

  const amount = parsePolicyAmount(formData.get("maxCostUsd"));
  if (!amount) return { error: "Enter a positive USD limit with at most six decimal places." };

  const activeRaw = String(formData.get("active") ?? "true").trim().toLowerCase();
  const active = activeRaw === "true" || activeRaw === "1" ? true : activeRaw === "false" || activeRaw === "0" ? false : null;
  if (active === null) return { error: "The active flag must be true or false." };

  const version = parseExpectedVersion(formData.get("version"));
  if (version === null) return { error: "Policy version must be a non-negative integer." };

  const { error } = await supabaseRpcClient().rpc("set_ai_model_budget_policy", {
    p_company: membership.companyId,
    p_task: task,
    p_max_cost_usd: amount,
    p_active: active,
    p_expected_version: version,
  });
  if (error) return { error: error.message.includes("stale") ? "This policy changed. Reload before updating it." : `Could not save policy: ${error.message}` };
  revalidatePath("/app/admin/model-budgets");
  return { ok: active ? "Model budget configured." : "Model budget disabled." };
}