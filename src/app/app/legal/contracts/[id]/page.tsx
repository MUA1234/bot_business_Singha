/**
 * Contract detail (§9.3): the contract + its obligations (add + mark done/waived).
 * Overdue obligations feed the Legal renewals dashboard. Company-scoped + audited.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { addObligation, setObligationStatus } from "../actions";

export const metadata = { title: "Contract — Singha" };

export default async function ContractDetail({ params }: { params: { id: string } }) {
  const p = await requireDepartment("legal");
  const db = supabaseAdmin();
  const now = new Date();

  const { data: c } = await db.from("contracts")
    .select("id, title, counterparty, start_date, end_date, renewal_date, status")
    .eq("id", params.id).eq("company_id", p.companyId).maybeSingle();
  if (!c) notFound();

  const { data: obligations } = await db.from("obligations")
    .select("id, description, due_date, status").eq("contract_id", c.id).eq("company_id", p.companyId).order("due_date", { ascending: true, nullsFirst: false });

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{c.title}</h1>
          <p className="muted mt-1">{c.counterparty ?? "—"} · <span className="badge">{c.status}</span> {c.renewal_date ? `· renews ${c.renewal_date}` : ""}</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal/contracts">← Contracts</Link>
      </div>

      <div className="card">
        <div className="card-title">Obligations</div>
        <form action={addObligation} className="row gap-1 wrap mt-2">
          <input type="hidden" name="contract_id" value={c.id} />
          <input name="description" className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Obligation / deliverable" required />
          <label className="small dim">Due <input name="due_date" type="date" className="input" style={{ width: 150 }} /></label>
          <button className="btn ghost sm" type="submit">Add</button>
        </form>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Obligation</th><th>Due</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(obligations ?? []).length === 0 && <tr><td colSpan={4}><div className="empty">No obligations.</div></td></tr>}
              {(obligations ?? []).map((o: any) => {
                const s = o.status === "open" ? renewalStatus(o.due_date ?? null, now, 30) : "none";
                const b = s === "expired" ? "danger" : s === "due_soon" ? "warn" : "";
                return (
                  <tr key={o.id}>
                    <td>{o.description}</td>
                    <td>{o.due_date ? <span className={`badge ${b}`}>{o.due_date}</span> : <span className="dim small">—</span>}</td>
                    <td><span className={`badge ${o.status === "done" ? "ok" : o.status === "waived" ? "" : "warn"}`}>{o.status}</span></td>
                    <td>
                      {o.status === "open" && (
                        <div className="row gap-1">
                          <form action={setObligationStatus}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="contract_id" value={c.id} /><input type="hidden" name="status" value="done" /><button className="btn ghost sm" type="submit">Done</button></form>
                          <form action={setObligationStatus}><input type="hidden" name="id" value={o.id} /><input type="hidden" name="contract_id" value={c.id} /><input type="hidden" name="status" value="waived" /><button className="btn ghost sm" type="submit">Waive</button></form>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
