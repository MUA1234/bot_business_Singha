/**
 * Marketing overview — live dashboard (§10). Campaigns, audiences, active leads.
 * Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Marketing — Singha" };

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
    <div className="stack gap-3">
      <div><h1>Marketing</h1><p className="muted mt-1">Campaigns, audiences and broadcasts.</p></div>
      <div className="grid cols-4">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat"><div className="k">{t.k}</div><div className="v" style={{ fontSize: "1.8rem" }}>{t.v}</div></Link>
        ))}
      </div>
    </div>
  );
}
