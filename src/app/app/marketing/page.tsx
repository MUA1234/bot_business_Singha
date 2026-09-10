/**
 * Marketing overview — live dashboard (§10). Campaigns, audiences, active leads.
 * Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { Icon } from "@/components/Icon";
import { fmtNumber } from "@/lib/format";
import { PageHead, Section } from "@/components/os/primitives";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Marketing — Singha Central" };

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try { return (await run()).count ?? 0; } catch { return 0; }
}

export default async function MarketingHome() {
  const p = await requireDepartment("marketing");
  const db = supabaseReadClient();

  const [running, draft, audiences, leads] = await Promise.all([
    count(() => db.from("campaigns").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "running") as any),
    count(() => db.from("campaigns").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "draft") as any),
    count(() => db.from("audiences").select("id", { count: "exact", head: true }).eq("company_id", p.companyId) as any),
    count(() => db.from("leads").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).not("stage", "in", "(won,lost)") as any),
  ]);

  const tiles = [
    { k: "Running campaigns", v: running, href: "/app/marketing/campaigns" },
    { k: "Draft campaigns", v: draft, href: "/app/marketing/campaigns" },
    { k: "Audiences", v: audiences, href: "/app/marketing/audiences" },
    { k: "Active leads", v: leads, href: "/app/sales/leads" },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Relations"
        title="Marketing"
        lede="Campaigns, audiences and broadcasts. A broadcast outside the 24-hour customer-service window may only use an approved template — the system enforces that, it is not left to the sender."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/marketing/campaigns">Campaigns</Link>
            <Link className="btn ghost sm" href="/app/marketing/audiences">Audiences</Link>
          </>
        }
      />

      <Section title="Position" />
      <div className="grid cols-4">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v">{fmtNumber(t.v)}</div>
          </Link>
        ))}
      </div>

      <Section title="The rest of Marketing" />
      <div className="grid cols-3">
        {[
          { href: "/app/marketing/campaigns", label: "Campaigns", icon: "rocket", note: "What is running, drafted and finished" },
          { href: "/app/marketing/audiences", label: "Audiences", icon: "target", note: "Who a campaign reaches, and their consent" },
          { href: "/app/sales/leads", label: "Leads", icon: "user-round", note: "Enquiries a campaign produced" },
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
