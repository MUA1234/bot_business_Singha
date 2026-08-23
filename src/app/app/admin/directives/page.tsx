/**
 * Admin → Management directives (GOV-001). Company-scoped registry of directives
 * issued to named humans with a required response window and acknowledgement tracking.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { createDirective, acknowledgeDirective, closeDirective } from "./actions";

export const metadata = { title: "Directives — Singha Central" };

export default async function DirectivesPage() {
  const admin = await requireAdmin();
  const now = new Date().toISOString();

  let directives: any[] = [];
  let people: any[] = [];
  try {
    directives = (await supabaseReadClient()
      .from("management_directives")
      .select("id, title, body, issued_by, issued_to, response_required_by, status, response, acknowledged_at")
      .eq("company_id", admin.companyId)
      .order("response_required_by", { ascending: true })
      .limit(200)).data ?? [];

    people = (await supabaseReadClient()
      .from("profiles")
      .select("id, full_name, username")
      .eq("company_id", admin.companyId)
      .order("full_name")
      .limit(200)).data ?? [];
  } catch {
    // leave lists empty
  }

  const personName = (id: string) => people.find((p) => p.id === id)?.full_name ?? people.find((p) => p.id === id)?.username ?? id.slice(0, 8);

  const openCount = directives.filter((d) => d.status === "issued" || d.status === "overdue").length;
  const overdueCount = directives.filter((d) => d.status === "issued" && d.response_required_by < now).length;

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Management directives</h1>
          <p className="muted mt-1">Issue directives and track response obligations.</p>
        </div>
        <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Open</div><div className="v">{openCount}</div></div>
        <div className="card stat"><div className="k">Overdue</div><div className="v">{overdueCount}</div></div>
        <div className="card stat"><div className="k">Total</div><div className="v">{directives.length}</div></div>
      </div>

      <div className="card">
        <div className="card-title">New directive</div>
        <form action={createDirective} className="stack gap-2 mt-2">
          <input name="title" className="input" placeholder="Directive title" required />
          <textarea name="body" className="textarea" placeholder="What the recipient must respond to" style={{ minHeight: 80 }} />
          <div className="row gap-1 wrap">
            <select name="issued_to" className="input" style={{ minWidth: 200 }} required>
              <option value="">Recipient…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.username}</option>)}
            </select>
            <label className="row gap-1 small">Response due <input name="response_required_by" type="datetime-local" className="input" required /></label>
          </div>
          <button className="btn" type="submit">Issue directive</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Directives ({directives.length})</div>
        {directives.length === 0 ? (
          <div className="empty">No directives yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Title</th><th>Recipient</th><th>Due</th><th>Status</th><th>Response</th><th></th></tr></thead>
              <tbody>
                {directives.map((d) => {
                  const isOverdue = d.status === "issued" && d.response_required_by < now;
                  return (
                    <tr key={d.id}>
                      <td style={{ fontWeight: 600 }}>{d.title}</td>
                      <td className="dim small">{personName(d.issued_to)}</td>
                      <td><span className={`badge ${isOverdue ? "danger" : ""}`}>{d.response_required_by?.replace("T", " ").slice(0, 16) ?? "—"}</span></td>
                      <td><span className="badge">{isOverdue ? "overdue" : d.status}</span></td>
                      <td className="dim small">{d.response ?? "—"}</td>
                      <td>
                        {d.status === "issued" && (
                          <form action={closeDirective}><input type="hidden" name="id" value={d.id} /><button className="btn ghost sm" type="submit">Close</button></form>
                        )}
                        {d.status === "issued" && d.issued_to === admin.userId && (
                          <form action={acknowledgeDirective} className="stack gap-1">
                            <input type="hidden" name="id" value={d.id} />
                            <input name="response" className="input sm" placeholder="Response" />
                            <button className="btn sm" type="submit">Acknowledge</button>
                          </form>
                        )}
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
