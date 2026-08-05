"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeAudit } from "@/lib/audit";
import { monthlyPeriods } from "@/accounting/periods";

async function requireFinance() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "finance") throw new Error("Not allowed");
  return p;
}

/** Create a fiscal year (Jan–Dec) and its twelve monthly periods. */
export async function createFiscalYear(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const db = supabaseAdmin();
  const year = Math.trunc(Number(formData.get("year") ?? 0));
  if (!(year >= 2000 && year <= 2100)) return;

  const { data: fy, error } = await db.from("fiscal_years")
    .insert({ company_id: p.companyId, name: String(year), start_date: `${year}-01-01`, end_date: `${year}-12-31`, status: "open" })
    .select("id").maybeSingle();
  if (error || !fy) return;

  const periods = monthlyPeriods(year).map((pp) => ({ company_id: p.companyId, fiscal_year_id: fy.id, name: pp.name, start_date: pp.start_date, end_date: pp.end_date, status: "open" }));
  await db.from("accounting_periods").insert(periods);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: "fiscal_year.created", entityType: "fiscal_year", entityId: fy.id, payload: { year } });
  revalidatePath("/app/finance/periods");
}

/** Close, lock or reopen a period. Reopening is a controlled, audited action (§8.1). */
export async function setPeriodStatus(formData: FormData): Promise<void> {
  const p = await requireFinance();
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!id || !["open", "closed", "locked"].includes(status)) return;

  const { data: period } = await supabaseAdmin().from("accounting_periods").select("id").eq("id", id).eq("company_id", p.companyId).maybeSingle();
  if (!period) return;

  const patch: Record<string, unknown> = { status };
  if (status === "closed" || status === "locked") { patch.closed_at = new Date().toISOString(); patch.closed_by = p.userId; }
  else { patch.closed_at = null; patch.closed_by = null; }
  await supabaseAdmin().from("accounting_periods").update(patch).eq("id", id).eq("company_id", p.companyId);
  await writeAudit({ companyId: p.companyId, actorId: p.userId, action: `period.${status}`, entityType: "accounting_period", entityId: id });
  revalidatePath("/app/finance/periods");
}
