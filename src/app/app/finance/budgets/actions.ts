"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";
import { parseMoneyInput } from "@/lib/money";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

function scenarioForecastName(budgetId: string): string {
  return `Budget scenario: ${budgetId}`;
}

async function getOrCreateBudgetForecast(db: ReturnType<typeof supabaseWriteClient>, companyId: string, budgetId: string, currency: string) {
  const name = scenarioForecastName(budgetId);
  const { data: existing } = await db
    .from("forecasts")
    .select("id")
    .eq("company_id", companyId)
    .eq("name", name)
    .maybeSingle();
  if (existing) return existing.id;

  const { data: created, error } = await db
    .from("forecasts")
    .insert({ company_id: companyId, name, currency, horizon_days: 365 })
    .select("id")
    .maybeSingle();
  if (error || !created) throw new Error(`Could not create forecast: ${error?.message ?? "unknown"}`);
  return created.id;
}

/** Create a company-scoped budget and its companion forecast for scenarios. */
export async function createBudget(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();

  const name = String(formData.get("name") ?? "").trim();
  const fiscalYearId = String(formData.get("fiscal_year_id") ?? "").trim();
  const currency = String(formData.get("currency") ?? "LKR").trim().toUpperCase();

  if (!name || !/^[A-Z]{3}$/.test(currency)) return;

  const insert: Record<string, unknown> = { company_id: p.companyId, name, currency };
  if (fiscalYearId) insert.fiscal_year_id = fiscalYearId;

  const { data: budget, error } = await db.from("budgets").insert(insert).select("id, currency").maybeSingle();
  if (error || !budget) return;

  // Every budget gets a companion forecast used for its scenario assumptions.
  await getOrCreateBudgetForecast(db, p.companyId, budget.id, budget.currency as string);

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "budget.created",
    entityType: "budget",
    entityId: budget.id,
    payload: { name, fiscal_year_id: fiscalYearId || null, currency },
  });
  revalidatePath("/app/finance/budgets");
}

/** Add a line to a budget. */
export async function createBudgetLine(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();

  const budgetId = String(formData.get("budget_id") ?? "").trim();
  const accountCode = String(formData.get("account_code") ?? "").trim() || null;
  const periodId = String(formData.get("period_id") ?? "").trim() || null;
  const projectId = String(formData.get("project_id") ?? "").trim() || null;
  const amountRaw = String(formData.get("amount") ?? "").trim();

  if (!budgetId || !amountRaw) return;

  const { data: budget } = await db.from("budgets").select("id, currency").eq("id", budgetId).eq("company_id", p.companyId).maybeSingle();
  if (!budget) return;

  const amount = parseMoneyInput(amountRaw, budget.currency as string);
  if (!amount) return;

  const { data: line, error } = await db
    .from("budget_lines")
    .insert({
      company_id: p.companyId,
      budget_id: budgetId,
      account_code: accountCode,
      period_id: periodId,
      project_id: projectId,
      amount: amount.toRawString(),
    })
    .select("id")
    .maybeSingle();
  if (error || !line) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "budget_line.created",
    entityType: "budget_line",
    entityId: line.id,
    payload: { budget_id: budgetId, account_code: accountCode, period_id: periodId, project_id: projectId, amount: amount.toString() },
  });
  revalidatePath(`/app/finance/budgets/${budgetId}`);
  revalidatePath("/app/finance/budgets");
}

/** Create a forecast scenario for a budget. */
export async function createScenario(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseWriteClient();

  const budgetId = String(formData.get("budget_id") ?? "").trim();
  const kind = String(formData.get("kind") ?? "").trim();
  const assumptionsRaw = String(formData.get("assumptions") ?? "{}").trim();

  if (!budgetId || !["best", "expected", "worst"].includes(kind)) return;

  const { data: budget } = await db.from("budgets").select("id, currency").eq("id", budgetId).eq("company_id", p.companyId).maybeSingle();
  if (!budget) return;

  let assumptions: Record<string, unknown>;
  try {
    assumptions = JSON.parse(assumptionsRaw);
  } catch {
    return;
  }

  const forecastId = await getOrCreateBudgetForecast(db, p.companyId, budgetId, budget.currency as string);

  const { data: scenario, error } = await db
    .from("forecast_scenarios")
    .insert({ forecast_id: forecastId, company_id: p.companyId, kind, assumptions })
    .select("id")
    .maybeSingle();
  if (error || !scenario) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "forecast_scenario.created",
    entityType: "forecast_scenario",
    entityId: scenario.id,
    payload: { budget_id: budgetId, forecast_id: forecastId, kind, assumptions },
  });
  revalidatePath(`/app/finance/budgets/${budgetId}`);
}
