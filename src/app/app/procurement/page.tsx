/**
 * Procurement overview — live dashboard (§10). Open PRs/POs/RFQs + inventory reorder
 * count. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { reorderList } from "@/modules/procurement/inventory";

export const metadata = { title: "Procurement — Singha Central" };

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try { return (await run()).count ?? 0; } catch { return 0; }
}
async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try { return (await run()).data ?? []; } catch { return []; }
}

export default async function ProcurementHome() {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const [openPRs, openPOs, openRFQs, suppliers, items] = await Promise.all([
    count(() => db.from("purchase_requests").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).not("status", "in", "(closed,rejected)") as any),
    count(() => db.from("purchase_orders").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).not("status", "in", "(received,closed,cancelled)") as any),
    count(() => db.from("rfqs").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "open") as any),
    count(() => db.from("suppliers").select("id", { count: "exact", head: true }).eq("company_id", p.companyId) as any),
    rows<any>(() => db.from("inventory_items").select("quantity_on_hand, reorder_level").eq("company_id", p.companyId) as any),
  ]);
  const reorder = reorderList(items.map((i) => ({ quantityOnHand: Number(i.quantity_on_hand ?? 0), reorderLevel: Number(i.reorder_level ?? 0) }))).length;

  const tiles = [
    { k: "Open requests", v: openPRs, href: "/app/procurement/purchase-requests" },
    { k: "Open POs", v: openPOs, href: "/app/procurement/purchase-orders" },
    { k: "Open RFQs", v: openRFQs, href: "/app/procurement/rfqs" },
    { k: "Below reorder", v: reorder, href: "/app/procurement/inventory", danger: reorder > 0 },
    { k: "Suppliers", v: suppliers, href: "/app/procurement/suppliers" },
  ];

  return (
    <div className="stack gap-3">
      <div><h1>Procurement</h1><p className="muted mt-1">Suppliers, purchasing and inventory.</p></div>
      <div className="grid cols-3">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat"><div className="k">{t.k}</div><div className="v" style={{ fontSize: "1.8rem", color: t.danger ? "var(--danger)" : undefined }}>{t.v}</div></Link>
        ))}
      </div>
    </div>
  );
}
