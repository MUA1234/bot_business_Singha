/**
 * Legal & Compliance overview (§9.3). Runs the pure renewal detector over licences,
 * contract renewal dates and obligation deadlines and surfaces what's expired or due
 * soon — worst first. Read-only, company-scoped, graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { Icon } from "@/components/Icon";
import { fmtNumber } from "@/lib/format";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

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

  const expired = alerts.filter((a) => a.status === "expired");
  const dueSoon = alerts.filter((a) => a.status !== "expired");

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Govern"
        title="Risk and governance"
        lede="Obligations, licences, contracts, insurances, risks and incidents — what falls due, what has lapsed, and what is still open. Ordered worst first."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/legal/risks">Risks</Link>
            <Link className="btn ghost sm" href="/app/legal/obligations">Obligations</Link>
          </>
        }
      />

      {alerts.length > 0 && (
        <>
          <Section title="Needs a decision" meta="expired or due within 45 days" />
          <div className="field-matters">
            {expired.length > 0 && (
              <Matter
                kind="Lapsed"
                kindIcon="alert-triangle"
                band="critical"
                title={`${expired.length} obligation, licence or renewal ${expired.length === 1 ? "has" : "have"} already passed its date`}
                footer={<Signal kind="critical">Operating past an obligation date is an exposure</Signal>}
              />
            )}
            {dueSoon.length > 0 && (
              <Matter
                kind="Falling due"
                kindIcon="clock"
                band="high"
                title={`${dueSoon.length} ${dueSoon.length === 1 ? "date falls" : "dates fall"} due within 45 days`}
                footer={<Signal kind="warn">Act before the date, not after</Signal>}
              />
            )}
          </div>
        </>
      )}

      <Section title="Position" />
      <div className="grid cols-3">
        <Link href="/app/legal/licences" className="card stat">
          <div className="k">Licences</div>
          <div className="v">{fmtNumber(licences.length)}</div>
        </Link>
        <Link href="/app/legal/contracts" className="card stat">
          <div className="k">Contracts</div>
          <div className="v">{fmtNumber(contracts.length)}</div>
        </Link>
        <Link href="/app/legal/obligations" className="card stat">
          <div className="k">Open obligations</div>
          <div className="v">{fmtNumber(obligations.length)}</div>
        </Link>
        <Link href="/app/legal/risks" className="card stat">
          <div className="k">Open risks</div>
          <div className="v">{fmtNumber(risks.length)}</div>
          <div className="d">
            {risks.length > 0 ? (
              <Signal kind="warn">Each needs an owner and a date</Signal>
            ) : (
              <Signal kind="ok">None open</Signal>
            )}
          </div>
        </Link>
        <Link href="/app/legal/insurances" className="card stat">
          <div className="k">Active insurances</div>
          <div className="v">{fmtNumber(insurances.length)}</div>
        </Link>
        <Link href="/app/legal/incidents" className="card stat">
          <div className="k">Open incidents</div>
          <div className="v">{fmtNumber(incidents.length)}</div>
          <div className="d">
            {incidents.length > 0 ? (
              <Signal kind="critical">Unresolved</Signal>
            ) : (
              <Signal kind="ok">None open</Signal>
            )}
          </div>
        </Link>
      </div>

      <Section title="Renewals and deadlines" meta="worst first, 45-day horizon" />
      <div className="card">
        {alerts.length === 0 ? (
          <StateNote kind="empty" title="Nothing expired or due within 45 days">
            Across the {fmtNumber(items.length)} dated record(s) read, none has passed its date or
            falls due in the next 45 days. A record with no date recorded is not counted here — it
            cannot be, and that is not the same as being safe.
          </StateNote>
        ) : (
          <div className="stack gap-1">
            {alerts.map((a) => (
              <div key={a.id} className="node-card">
                <span className="node-card-text">
                  <span className="node-card-title">{a.label}</span>
                  <span className="node-card-note">
                    {a.status === "expired" ? "Already past its date" : `Due in ${a.daysUntil} day(s)`}
                  </span>
                </span>
                <span className={`badge ${badge(a.severity)}`}>
                  {a.status === "expired" ? "expired" : `${a.daysUntil}d`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Section title="The rest of Legal and Compliance" />
      <div className="grid cols-3">
        {[
          { href: "/app/legal/matters", label: "Matters", icon: "gavel", note: "Live legal matters and their state" },
          { href: "/app/legal/contracts", label: "Contracts", icon: "scroll-text", note: "Terms, renewal dates and review dates" },
          { href: "/app/legal/licences", label: "Licences", icon: "shield", note: "Permissions to operate, and their expiry" },
          { href: "/app/legal/obligations", label: "Obligations", icon: "clipboard", note: "What we must do, and by when" },
          { href: "/app/legal/insurances", label: "Insurances", icon: "shield-alert", note: "Cover in force and its expiry" },
          { href: "/app/legal/risks", label: "Risks", icon: "alert-triangle", note: "Exposure, owner, mitigation and review" },
          { href: "/app/legal/incidents", label: "Incidents", icon: "flag", note: "What happened, and what followed" },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="node-card">
            <span className="node-card-ico" aria-hidden="true">
              <Icon name={item.icon} size={17} strokeWidth={1.6} />
            </span>
            <span className="node-card-text">
              <span className="node-card-title">{item.label}</span>
              <span className="node-card-note">{item.note}</span>
            </span>
            <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </div>
  );
}
