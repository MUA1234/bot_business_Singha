/**
 * Admin → Management directives (GOV-001 + GOV-003). Company-scoped registry of
 * directives issued to named humans, with optional target/action pairs and
 * automatic conflict detection/resolution.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { createDirective, acknowledgeDirective, closeDirective, escalateDirective, resolveDirectiveConflict } from "./actions";

export const metadata = { title: "Directives — Singha Central" };

const DIRECTIVE_ACTIONS = ["approve", "reject", "hold", "proceed", "stop"];

export default async function DirectivesPage() {
  const admin = await requireAdmin();
  const now = new Date().toISOString();

  let directives: any[] = [];
  let people: any[] = [];
  let conflicts: any[] = [];
  try {
    directives = (await supabaseReadClient()
      .from("management_directives")
      .select("id, title, body, issued_by, issued_to, response_required_by, status, response, acknowledged_at, target_type, target_id, action, escalation_chain, escalated_to, escalation_level, escalated_at, escalation_reason")
      .eq("company_id", admin.companyId)
      .order("response_required_by", { ascending: true })
      .limit(200)).data ?? [];

    people = (await supabaseReadClient()
      .from("profiles")
      .select("id, full_name, username")
      .eq("company_id", admin.companyId)
      .order("full_name")
      .limit(200)).data ?? [];

    conflicts = (await supabaseReadClient()
      .from("management_directive_conflicts")
      .select("id, directive_a_id, directive_b_id, target_type, target_id, status")
      .eq("company_id", admin.companyId)
      .eq("status", "open")
      .order("created_at", { ascending: false })
      .limit(100)).data ?? [];
  } catch {
    // leave lists empty
  }

  const personName = (id: string) => people.find((p) => p.id === id)?.full_name ?? people.find((p) => p.id === id)?.username ?? id.slice(0, 8);
  const directiveTitle = (id: string) => directives.find((d) => d.id === id)?.title ?? id.slice(0, 8);
  const directiveAction = (id: string) => directives.find((d) => d.id === id)?.action ?? "—";

  const openCount = directives.filter((d) => d.status === "issued" || d.status === "overdue").length;
  const overdueCount = directives.filter((d) => d.status === "issued" && d.response_required_by < now).length;
  const openConflictCount = conflicts.length;

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Management directives</h1>
          <p className="muted mt-1">Issue directives and track response obligations.</p>
        </div>
        <div className="row gap-1">
          <a href="#conflicts" className="btn ghost sm">Conflicts</a>
          <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
        </div>
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
          <div className="row gap-1 wrap">
            <input name="target_type" className="input sm" placeholder="Target type (e.g. task)" />
            <input name="target_id" className="input sm" placeholder="Target id" />
            <select name="action" className="input sm" style={{ minWidth: 140 }}>
              <option value="">Action…</option>
              {DIRECTIVE_ACTIONS.map((a) => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="row gap-1 wrap">
            <select name="escalation_chain" className="input" style={{ minWidth: 240 }} multiple size={Math.min(4, people.length || 1)}>
              <option value="" disabled>Escalation chain (optional, Ctrl/Cmd-select)…</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name ?? p.username}</option>)}
            </select>
          </div>
          <button className="btn" type="submit">Issue directive</button>
        </form>
      </div>

      <div className="card" id="conflicts">
        <div className="card-title">Conflicts ({openConflictCount} open)</div>
        {conflicts.length === 0 ? (
          <div className="empty">No open directive conflicts.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr>
                  <th>Directive A</th>
                  <th>Action A</th>
                  <th>Directive B</th>
                  <th>Action B</th>
                  <th>Target</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {conflicts.map((c) => (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{directiveTitle(c.directive_a_id)}</td>
                    <td><span className="badge">{directiveAction(c.directive_a_id)}</span></td>
                    <td style={{ fontWeight: 600 }}>{directiveTitle(c.directive_b_id)}</td>
                    <td><span className="badge">{directiveAction(c.directive_b_id)}</span></td>
                    <td className="dim small">{c.target_type ?? "—"}:{c.target_id ?? "—"}</td>
                    <td>
                      <form action={resolveDirectiveConflict} className="stack gap-1">
                        <input type="hidden" name="id" value={c.id} />
                        <input name="resolution" className="input sm" placeholder="Resolution reason" required />
                        <button className="btn sm" type="submit">Resolve</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Directives ({directives.length})</div>
        {directives.length === 0 ? (
          <div className="empty">No directives yet.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Title</th><th>Recipient</th><th>Due</th><th>Status</th><th>Escalation</th><th>Response</th><th></th></tr></thead>
              <tbody>
                {directives.map((d) => {
                  const isOverdue = (d.status === "issued" || d.status === "escalated") && d.response_required_by < now;
                  const displayStatus = isOverdue ? "overdue" : d.status;
                  const canAcknowledge = d.status !== "acknowledged" && d.status !== "closed" && (d.issued_to === admin.userId || d.escalated_to === admin.userId);
                  const chain = Array.isArray(d.escalation_chain) ? (d.escalation_chain as string[]) : [];
                  const canEscalate = chain.length > 0 && (d.status === "issued" || d.status === "escalated") && Number(d.escalation_level ?? 0) < chain.length;
                  return (
                    <tr key={d.id}>
                      <td style={{ fontWeight: 600 }}>{d.title}</td>
                      <td className="dim small">{personName(d.issued_to)}</td>
                      <td><span className={`badge ${isOverdue ? "danger" : ""}`}>{d.response_required_by?.replace("T", " ").slice(0, 16) ?? "—"}</span></td>
                      <td><span className={`badge ${isOverdue ? "danger" : ""}`}>{displayStatus}</span></td>
                      <td className="dim small">
                        {d.status === "escalated" && (
                          <span>L{d.escalation_level ?? 1} → {personName(d.escalated_to)}</span>
                        )}
                        {isOverdue && d.status !== "escalated" && <span>overdue</span>}
                        {!isOverdue && d.status !== "escalated" && <span>—</span>}
                      </td>
                      <td className="dim small">{d.response ?? "—"}</td>
                      <td>
                        <div className="row gap-1 wrap">
                          {d.status !== "acknowledged" && d.status !== "closed" && (
                            <form action={closeDirective}><input type="hidden" name="id" value={d.id} /><button className="btn ghost sm" type="submit">Close</button></form>
                          )}
                          {canEscalate && (
                            <form action={escalateDirective}><input type="hidden" name="id" value={d.id} /><button className="btn ghost sm" type="submit">Escalate</button></form>
                          )}
                          {canAcknowledge && (
                            <form action={acknowledgeDirective} className="stack gap-1">
                              <input type="hidden" name="id" value={d.id} />
                              <input name="response" className="input sm" placeholder="Response" />
                              <button className="btn sm" type="submit">Acknowledge</button>
                            </form>
                          )}
                        </div>
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
