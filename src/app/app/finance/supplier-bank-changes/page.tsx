/**
 * Supplier bank-detail changes (§WP2.5). Maker/checker: finance requests a change; a
 * DIFFERENT finance/admin user approves it before it applies to the supplier. Read +
 * request + decide. Company-scoped; graceful if migration 0029 has not been applied.
 */
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { requestBankChange, decideBankChange } from "./actions";

export const metadata = { title: "Supplier Bank Changes — Singha" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function BankChangesPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [suppliers, changes] = await Promise.all([
    rows<any>(() => db.from("suppliers").select("id, name, bank_account_name, bank_account_number").eq("company_id", p.companyId).eq("status", "active").order("name") as any),
    rows<any>(() => db.from("supplier_bank_detail_changes").select("id, supplier_id, old_account_number, new_account_number, new_account_name, requested_by, status, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(50) as any),
  ]);
  const nameOf = (sid: string) => suppliers.find((s) => s.id === sid)?.name ?? sid;

  return (
    <div className="stack gap-3">
      <div>
        <h1>Supplier bank changes</h1>
        <p className="muted mt-1">A bank-detail change is sensitive: it must be requested by one person and approved by another before it applies.</p>
      </div>

      <div className="card">
        <div className="card-title">Request a change</div>
        <form action={requestBankChange} className="row gap-1 wrap mt-2">
          <select name="supplier_id" className="select" style={{ minWidth: 180 }} required>
            <option value="">Select supplier…</option>
            {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input name="new_account_name" className="input" style={{ width: 180 }} placeholder="New account name" />
          <input name="new_account_number" className="input" style={{ width: 180 }} placeholder="New account number" />
          <button className="btn ghost sm" type="submit">Request</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Recent changes</div>
        {changes.length === 0 ? (
          <div className="empty mt-2">No bank-detail changes yet.</div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="data">
              <thead><tr><th>When</th><th>Supplier</th><th>New account</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {changes.map((c) => {
                  const isRequester = c.requested_by === p.userId;
                  return (
                    <tr key={c.id}>
                      <td className="small dim">{new Date(c.created_at).toLocaleDateString()}</td>
                      <td>{nameOf(c.supplier_id)}</td>
                      <td className="small">{c.new_account_name ? `${c.new_account_name} · ` : ""}{c.new_account_number ?? ""}</td>
                      <td><span className={`badge ${c.status === "approved" ? "ok" : c.status === "rejected" ? "danger" : "warn"}`}>{c.status}</span></td>
                      <td>
                        {c.status === "pending" && (isRequester ? (
                          <span className="small dim">awaiting another approver</span>
                        ) : (
                          <div className="row gap-1">
                            <form action={decideBankChange}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="approved" /><button className="btn sm" type="submit">Approve</button></form>
                            <form action={decideBankChange}><input type="hidden" name="id" value={c.id} /><input type="hidden" name="decision" value="rejected" /><button className="btn ghost sm" type="submit">Reject</button></form>
                          </div>
                        ))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
