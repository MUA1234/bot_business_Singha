/**
 * Procurement overview — live dashboard (§10). Open PRs/POs/RFQs + inventory reorder
 * count. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { reorderList } from "@/modules/procurement/inventory";
import { Icon } from "@/components/Icon";
import { fmtNumber } from "@/lib/format";
import { Matter, PageHead, Section, Signal } from "@/components/os/primitives";

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

  const [openPRs, openPOs, openRFQs, suppliers, serviceProviders, items] = await Promise.all([
    count(() => db.from("purchase_requests").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).not("status", "in", "(closed,rejected)") as any),
    count(() => db.from("purchase_orders").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).not("status", "in", "(received,closed,cancelled)") as any),
    count(() => db.from("rfqs").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "open") as any),
    count(() => db.from("suppliers").select("id", { count: "exact", head: true }).eq("company_id", p.companyId) as any),
    count(() => db.from("service_providers").select("id", { count: "exact", head: true }).eq("company_id", p.companyId) as any),
    rows<any>(() => db.from("inventory_items").select("quantity_on_hand, reorder_level").eq("company_id", p.companyId) as any),
  ]);
  const reorder = reorderList(items.map((i) => ({ quantityOnHand: Number(i.quantity_on_hand ?? 0), reorderLevel: Number(i.reorder_level ?? 0) }))).length;

  const tiles = [
    { k: "Open requests", v: openPRs, href: "/app/procurement/purchase-requests" },
    { k: "Open POs", v: openPOs, href: "/app/procurement/purchase-orders" },
    { k: "Open RFQs", v: openRFQs, href: "/app/procurement/rfqs" },
    { k: "Below reorder", v: reorder, href: "/app/procurement/inventory", danger: reorder > 0 },
    { k: "Suppliers", v: suppliers, href: "/app/procurement/suppliers" },
    { k: "Service providers", v: serviceProviders, href: "/app/procurement/service-providers" },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Supply"
        title="Procurement"
        lede="Requests, quotations, purchase orders and stock. Every figure is a count of records in this company."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/procurement/rfqs">RFQs</Link>
            <Link className="btn ghost sm" href="/app/procurement/purchase-orders">Purchase orders</Link>
          </>
        }
      />

      {reorder > 0 && (
        <>
          <Section title="Needs a decision" />
          <div className="field-matters">
            <Matter
              kind="Stock"
              kindIcon="warehouse"
              band="critical"
              title={`${reorder} item${reorder === 1 ? "" : "s"} at or below the reorder level`}
              href="/app/procurement/inventory"
              footer={<Signal kind="critical">Reorder before the shortfall stops work</Signal>}
            />
          </div>
        </>
      )}

      <Section title="Position" />
      <div className="grid cols-3">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v">{fmtNumber(t.v)}</div>
            {t.danger && (
              <div className="d">
                <Signal kind="critical">Below the reorder level</Signal>
              </div>
            )}
          </Link>
        ))}
      </div>

      <Section title="The rest of Procurement" />
      <div className="grid cols-3">
        {[
          { href: "/app/procurement/suppliers", label: "Suppliers", icon: "factory", note: "Who we buy from, and their history" },
          { href: "/app/procurement/service-providers", label: "Service providers", icon: "briefcase", note: "External capability we call on" },
          { href: "/app/procurement/rfqs", label: "RFQs", icon: "help-circle", note: "Requests out for quotation" },
          { href: "/app/procurement/purchase-requests", label: "Purchase requests", icon: "clipboard", note: "What departments have asked for" },
          { href: "/app/procurement/purchase-orders", label: "Purchase orders", icon: "package", note: "What we have committed to buy" },
          { href: "/app/procurement/inventory", label: "Inventory", icon: "warehouse", note: "What is on hand, and what is short" },
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
