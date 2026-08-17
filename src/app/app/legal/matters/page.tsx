/**
 * Legal → Matters (§9.3). Company-scoped create + status flow. Audited, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createMatter, setMatterStatus } from "./actions";

export const metadata = { title: "Legal Matters — Singha Central" };
const NEXT: Record<string, string[]> = { open: ["on_hold", "closed"], on_hold: ["open", "closed"], closed: ["open"] };

export default async function MattersPage() {
  const p = await requireDepartment("legal");

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("legal_matters").select("id, title, matter_type, status, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Legal Matters</h1><p className="muted mt-1">Cases and issues you&apos;re managing.</p></div>
        <Link className="btn ghost sm" href="/app/legal">← Legal</Link>
      </div>

      <div className="card">
        <div className="card-title">New matter</div>
        <form action={createMatter} className="row gap-1 wrap mt-2">
          <input name="title" className="input" style={{ flex: 1, minWidth: 180 }} placeholder="Matter title" required />
          <input name="matter_type" className="input" style={{ width: 150 }} placeholder="Type" />
          <button className="btn" type="submit">Add</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Matters ({rows.length})</div>
        {rows.length === 0 ? <div className="empty">No matters yet.</div> : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Matter</th><th>Type</th><th>Status</th><th>Move to</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.title}</td>
                    <td className="dim small">{r.matter_type ?? "—"}</td>
                    <td><span className={`badge ${r.status === "closed" ? "ok" : r.status === "on_hold" ? "warn" : ""}`}>{r.status.replace("_", " ")}</span></td>
                    <td>
                      <div className="row gap-1 wrap">
                        {(NEXT[r.status] ?? []).map((s) => (
                          <form action={setMatterStatus} key={s}><input type="hidden" name="id" value={r.id} /><input type="hidden" name="status" value={s} /><button className="btn ghost sm" type="submit">{s.replace("_", " ")}</button></form>
                        ))}
                      </div>
                    </td>
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
