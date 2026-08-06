/**
 * Finance → Journals (§8.1/§8.2). Lists posted journals. Posted entries are
 * immutable. Read-only list; company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Journals — Singha" };

export default async function JournalsPage() {
  const p = await requireDepartment("finance");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("journal_entries")
      .select("id, posting_date, currency, memo, status, total_debit, total_credit")
      .eq("company_id", p.companyId)
      .order("posting_date", { ascending: false })
      .limit(200);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Journals</h1>
          <p className="muted mt-1">Posted double-entry journals — the accounting source of truth.</p>
        </div>
        <div className="row gap-1">
          <Link className="btn ghost sm" href="/app/finance/trial-balance">Trial balance</Link>
          <Link className="btn sm" href="/app/finance/journals/new">New journal</Link>
        </div>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No journals yet. <Link href="/app/finance/journals/new">Post one →</Link></div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Date</th><th>Memo</th><th>Status</th><th className="num">Debit</th><th className="num">Credit</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="dim small">{r.posting_date}</td>
                    <td>{r.memo ?? "—"}</td>
                    <td><span className={`badge ${r.status === "posted" ? "ok" : r.status === "reversed" ? "warn" : ""}`}>{r.status}</span></td>
                    <td className="num">{r.currency} {Number(r.total_debit ?? 0).toLocaleString()}</td>
                    <td className="num">{r.currency} {Number(r.total_credit ?? 0).toLocaleString()}</td>
                    <td><Link className="btn ghost sm" href={`/app/finance/journals/${r.id}`}>View</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
