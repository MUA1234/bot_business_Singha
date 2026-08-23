/**
 * RSK-005 — Obligations register (contractual + statutory).
 * Company-scoped list and create form, with due-date status from the renewal detector.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { createObligation, updateObligationStatus } from "./actions";

export const metadata = { title: "Obligations — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function ObligationsPage() {
  const p = await requireDepartment("legal");
  const db = supabaseReadClient();
  const now = new Date();

  const [rows, contracts] = await Promise.all([
    safe<any>(() =>
      db
        .from("obligations")
        .select("id, description, due_date, status, obligation_type, evidence, contract_id")
        .eq("company_id", p.companyId)
        .order("due_date", { ascending: true, nullsFirst: false })
        .limit(300) as any,
    ),
    safe<any>(() => db.from("contracts").select("id, title").eq("company_id", p.companyId).order("title") as any),
  ]);

  const contractById = new Map((contracts ?? []).map((c: any) => [c.id, c.title]));

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Obligations register</h1>
          <p className="muted mt-1">Contractual and statutory obligations with due dates and evidence.</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New obligation</div>
        <form action={createObligation} className="stack gap-2 mt-2">
          <div className="row gap-1 wrap">
            <input name="description" className="input" style={{ flex: 2, minWidth: 160 }} placeholder="Obligation description" required />
            <select name="obligation_type" className="input" style={{ width: 130 }} defaultValue="statutory">
              <option value="statutory">Statutory</option>
              <option value="contractual">Contractual</option>
            </select>
            <label className="small dim">Due <input name="due_date" type="date" className="input" style={{ width: 150 }} /></label>
            <select name="contract_id" className="input" style={{ width: 180 }}>
              <option value="">No contract</option>
              {contracts.map((c: any) => <option key={c.id} value={c.id}>{c.title}</option>)}
            </select>
          </div>
          <textarea name="evidence" className="textarea" placeholder="Evidence / statutory reference" />
          <button className="btn" type="submit">Add obligation</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All obligations ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No obligations recorded yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Obligation</th><th>Type</th><th>Due</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {rows.map((r: any) => {
                  const st = renewalStatus(r.due_date ?? null, now, 45);
                  const badge = st === "expired" ? "danger" : st === "due_soon" ? "warn" : "";
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.description}</div>
                        {r.contract_id ? <div className="small dim">Contract: {contractById.get(r.contract_id) ?? "—"}</div> : null}
                        {r.evidence ? <div className="small dim">Evidence: {r.evidence}</div> : null}
                      </td>
                      <td><span className="badge">{r.obligation_type}</span></td>
                      <td>{r.due_date ? <span className={`badge ${badge}`}>{r.due_date}</span> : <span className="dim small">—</span>}</td>
                      <td><span className="badge">{r.status}</span></td>
                      <td>
                        <form action={updateObligationStatus} className="row gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <select name="status" className="input sm" defaultValue={r.status}>
                            <option value="open">open</option>
                            <option value="done">done</option>
                            <option value="overdue">overdue</option>
                            <option value="waived">waived</option>
                          </select>
                          <button className="btn sm" type="submit">Update</button>
                        </form>
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
