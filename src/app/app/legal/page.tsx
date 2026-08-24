/**
 * Legal & Compliance overview (§9.3). Runs the pure renewal detector over licences,
 * contract renewal dates and obligation deadlines and surfaces what's expired or due
 * soon — worst first. Read-only, company-scoped, graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";

import { supabaseReadClient } from "@/lib/supabase/read";
import { detectRenewals, type RenewalItem } from "@/management/ai-manager/renewals";

export const metadata = { title: "Legal & Compliance — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function LegalHome() {
  const p = await requireDepartment("legal");
  const db = supabaseReadClient();
  const now = new Date();

  const [licences, contracts, obligations, risks, insurances, incidents] = await Promise.all([
    safe<any>(() => db.from("licences").select("id, name, expiry_date").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("contracts").select("id, title, renewal_date").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("obligations").select("id, description, due_date, status").eq("company_id", p.companyId).neq("status", "done") as any),
    safe<any>(() => db.from("risks").select("id, title, review_date, status").eq("company_id", p.companyId).neq("status", "closed") as any),
    safe<any>(() => db.from("insurances").select("id, policy_name, expiry_date, status").eq("company_id", p.companyId).neq("status", "cancelled") as any),
    safe<any>(() => db.from("incidents").select("id").eq("company_id", p.companyId).neq("status", "closed") as any),
  ]);

  const items: RenewalItem[] = [
    ...licences.map((l) => ({ id: `lic-${l.id}`, label: `Licence: ${l.name}`, dueDate: l.expiry_date, kind: "licence" })),
    ...contracts.map((c) => ({ id: `con-${c.id}`, label: `Contract renewal: ${c.title}`, dueDate: c.renewal_date, kind: "contract" })),
    ...obligations.map((o) => ({ id: `obl-${o.id}`, label: `Obligation: ${o.description}`, dueDate: o.due_date, kind: "obligation" })),
    ...risks.map((r) => ({ id: `risk-${r.id}`, label: `Risk review: ${r.title}`, dueDate: r.review_date, kind: "risk" })),
    ...insurances.map((i) => ({ id: `ins-${i.id}`, label: `Insurance renewal: ${i.policy_name}`, dueDate: i.expiry_date, kind: "insurance" })),
  ];
  const alerts = detectRenewals(items, now, 45);
  const badge = (s: string) => (s === "critical" ? "danger" : s === "warn" ? "warn" : "info");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Legal &amp; Compliance</h1>
          <p className="muted mt-1">Licences, contracts and obligations due or expired.</p>
        </div>
        <Link className="btn ghost sm" href="/app/legal/contracts">Contracts →</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Licences</div><div className="v" style={{ fontSize: "1.5rem" }}>{licences.length}</div></div>
        <div className="card stat"><div className="k">Contracts</div><div className="v" style={{ fontSize: "1.5rem" }}>{contracts.length}</div></div>
        <div className="card stat"><div className="k">Open obligations</div><div className="v" style={{ fontSize: "1.5rem" }}>{obligations.length}</div></div>
        <div className="card stat"><div className="k">Open risks</div><div className="v" style={{ fontSize: "1.5rem" }}>{risks.length}</div></div>
        <div className="card stat"><div className="k">Active insurances</div><div className="v" style={{ fontSize: "1.5rem" }}>{insurances.length}</div></div>
        <div className="card stat"><div className="k">Open incidents</div><div className="v" style={{ fontSize: "1.5rem" }}>{incidents.length}</div></div>
      </div>

      <div className="row gap-2">
        <Link className="btn ghost sm" href="/app/legal/licences">Licences →</Link>
        <Link className="btn ghost sm" href="/app/legal/contracts">Contracts →</Link>
        <Link className="btn ghost sm" href="/app/legal/risks">Risks →</Link>
        <Link className="btn ghost sm" href="/app/legal/insurances">Insurances →</Link>
        <Link className="btn ghost sm" href="/app/legal/obligations">Obligations →</Link>
        <Link className="btn ghost sm" href="/app/legal/incidents">Incidents →</Link>
      </div>

      <div className="card">
        <div className="card-title">Renewals &amp; deadlines</div>
        {alerts.length === 0 ? (
          <EmptyState title="Nothing expired or due within 45 days." icon="check-circle" />
        ) : (
          <div className="stack gap-1 mt-2">
            {alerts.map((a) => (
              <div key={a.id} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{a.label}</span>
                <span className={`badge ${badge(a.severity)}`}>
                  {a.status === "expired" ? "expired" : `${a.daysUntil}d`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
