import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Icon } from "@/components/Icon";

export const metadata = { title: "Admin — Singha Central" };

async function count(table: string, companyId: string, extra?: (q: any) => any): Promise<number> {
  let q = supabaseReadClient().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  if (extra) q = extra(q);
  const { count } = await q;
  return count ?? 0;
}

export default async function AdminHome() {
  const admin = await requireAdmin();
  const [employees, quotations, openPrice, orders] = await Promise.all([
    count("profiles", admin.companyId),
    count("quotations", admin.companyId),
    count("price_confirmations", admin.companyId, (q) => q.eq("status", "open")),
    count("orders", admin.companyId, (q) => q.eq("status", "new")),
  ]);

  const tiles = [
    { k: "Employees", v: employees, href: "/app/admin/employees", d: "Manage accounts" },
    { k: "New orders", v: orders, href: "/app/sales/orders", d: "From WhatsApp" },
    { k: "Quotations", v: quotations, href: "/app/sales/quotations", d: "All statuses" },
    { k: "Open price confirmations", v: openPrice, href: "/app/sales/price-requests", d: "Need a human price" },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Welcome, {admin.fullName || admin.username}</h1>
        <p className="muted mt-1">Full control — every department, every approval, every record.</p>
      </div>

      <div className="grid cols-4">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v">{t.v}</div>
            <div className="d dim">{t.d}</div>
          </Link>
        ))}
      </div>

      <div className="grid cols-3">
        <Link href="/app/admin/employees" className="card">
          <div className="card-title row gap-1"><Icon name="users" size={17} /> Employees</div>
          <p className="card-sub">Create logins and assign departments.</p>
        </Link>
        <Link href="/app/admin/departments" className="card">
          <div className="card-title row gap-1"><Icon name="building-2" size={17} /> Departments</div>
          <p className="card-sub">Enable or disable department dashboards.</p>
        </Link>
        <Link href="/app/admin/catalog" className="card">
          <div className="card-title row gap-1"><Icon name="tag" size={17} /> Products &amp; Prices</div>
          <p className="card-sub">The prices the AI quoting engine uses.</p>
        </Link>
        <Link href="/app/admin/outbox" className="card">
          <div className="card-title row gap-1"><Icon name="send" size={17} /> Outbox &amp; dead letters</div>
          <p className="card-sub">Outbound message delivery status; replay failures.</p>
        </Link>
        <Link href="/app/admin/integrations" className="card">
          <div className="card-title row gap-1"><Icon name="plug" size={17} /> Integrations</div>
          <p className="card-sub">Applications, connectors and event/command contracts.</p>
        </Link>
      </div>
    </div>
  );
}
