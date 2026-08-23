/**
 * Admin → Audit Log (§13). The append-only trail of privileged and AI actions,
 * company-scoped. Read-only; supports a simple entity filter via ?entity=. Every
 * action here was recorded by a domain service — the ledger of who did what.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { describeAction } from "@/lib/audit-format";

export const metadata = { title: "Audit Log — Singha Central" };

/** GOV-006 — entity types that record governance decisions and obligations. */
const GOVERNANCE_ENTITY_TYPES = [
  "management_directive",
  "approval_request",
  "policy_evaluation",
  "delegation",
  "authority_rule",
];

export default async function AuditPage({ searchParams }: { searchParams: { entity?: string; governance?: string } }) {
  const admin = await requireAdmin();
  const entity = (searchParams.entity ?? "").trim();
  const governance = searchParams.governance === "1" || searchParams.governance === "true";

  let rows: any[] = [];
  try {
    let q = supabaseReadClient().from("audit_events")
      .select("id, actor_type, actor_id, action, entity_type, entity_id, created_at")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(300);
    if (entity) q = q.eq("entity_type", entity);
    if (governance) q = q.in("entity_type", GOVERNANCE_ENTITY_TYPES);
    rows = (await q).data ?? [];
  } catch {
    rows = [];
  }

  const entities = [...new Set(rows.map((r) => r.entity_type))].sort();
  const actorBadge = (t: string) => (t === "ai" ? "warn" : t === "system" ? "info" : "");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Audit Log</h1>
          <p className="muted mt-1">Append-only record of privileged and AI actions.</p>
        </div>
        <div className="row gap-1">
          <a className="btn ghost sm" href="/api/exports/audit">Export CSV</a>
          <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
        </div>
      </div>

      <div className="row gap-1 wrap small">
        <Link className="btn ghost sm" href="/app/admin/audit">All</Link>
        <Link className={`btn ghost sm ${governance ? "active" : ""}`} href="/app/admin/audit?governance=1">Governance</Link>
        {entities.map((e) => (
          <Link key={e} className="btn ghost sm" href={`/app/admin/audit?entity=${encodeURIComponent(e)}`}>{e}</Link>
        ))}
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No audit events{entity ? ` for “${entity}”` : ""} yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="dim small">{new Date(r.created_at).toLocaleString()}</td>
                    <td><span className={`badge ${actorBadge(r.actor_type)}`}>{r.actor_type}</span></td>
                    <td>{describeAction(r.action)}</td>
                    <td className="dim small mono">{r.entity_type}{r.entity_id ? ` · ${String(r.entity_id).slice(0, 8)}` : ""}</td>
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
