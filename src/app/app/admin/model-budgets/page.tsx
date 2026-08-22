import { requireMembership, membershipHasCapability } from "@/lib/access";
import { supabaseReadClient } from "@/lib/supabase/read";
import { saveModelBudgetPolicy } from "./actions";

export default async function ModelBudgetsPage() {
  const membership = await requireMembership();
  const allowed = await membershipHasCapability(membership, "ai.model_budget.manage");
  if (!allowed) return <div className="notice err">You do not have permission to view model budget policies.</div>;
  const { data, error } = await supabaseReadClient().from("ai_model_budget_policies").select("task,max_cost_usd,is_active,version,updated_at").eq("company_id", membership.companyId).order("task");
  if (error) return <div className="notice err">Configuration required: {error.message}</div>;
  const rows = data ?? [];
  return <div className="stack gap-3"><h1>Model budgets</h1><p className="muted">Missing, disabled, or exhausted policies prevent model calls.</p>
    {rows.length === 0 ? <div className="notice">Configuration required. No active model budget policies exist.</div> : rows.map((row: any) => <div key={row.task} className="notice"><strong>{row.task}</strong>: ${row.max_cost_usd} {row.is_active ? "configured" : "disabled"} (v{row.version})</div>)}
    <form action={saveModelBudgetPolicy as any} className="stack gap-2"><select name="task" defaultValue="extraction"><option value="extraction">Extraction</option><option value="quotation">Quotation</option><option value="management">Management</option></select><input name="maxCostUsd" inputMode="decimal" placeholder="Daily USD limit" /><input name="version" type="hidden" value="0" /><button type="submit">Configure policy</button></form>
  </div>;
}