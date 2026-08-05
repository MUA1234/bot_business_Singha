/**
 * New manual journal (§8.2). Loads the company's active accounts and renders the
 * balanced-entry form. Posting is atomic + immutable via the RPC.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { JournalForm } from "./JournalForm";

export const metadata = { title: "New Journal — Singha" };

export default async function NewJournalPage() {
  const p = await requireDepartment("finance");

  let accounts: { code: string; name: string }[] = [];
  try {
    const { data } = await supabaseAdmin()
      .from("chart_of_accounts")
      .select("code, name")
      .eq("company_id", p.companyId)
      .eq("is_active", true)
      .order("code")
      .limit(500);
    accounts = data ?? [];
  } catch {
    accounts = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>New Journal</h1>
          <p className="muted mt-1">Post a balanced entry. It becomes immutable — corrections use reversals.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/journals">← Journals</Link>
      </div>

      {accounts.length === 0 ? (
        <div className="card"><div className="empty">Add accounts first in <Link href="/app/finance/chart-of-accounts">Chart of Accounts</Link>.</div></div>
      ) : (
        <div className="card"><JournalForm accounts={accounts} currency="LKR" /></div>
      )}
    </div>
  );
}
