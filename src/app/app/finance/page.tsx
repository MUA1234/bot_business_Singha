import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Finance — Singha" };

export default async function FinanceHome() {
  const p = await requireDepartment("finance");
  const db = supabaseAdmin();

  const [{ data: sent }, { count: openPrice }] = await Promise.all([
    db.from("quotations").select("total, currency, status").eq("company_id", p.companyId).eq("status", "sent"),
    db.from("price_confirmations").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "open"),
  ]);

  const currency = sent?.[0]?.currency ?? "LKR";
  const quotedValue = (sent ?? []).reduce((s: number, q: any) => s + Number(q.total || 0), 0);

  const tiles = [
    { k: "Quoted value (sent)", v: `${currency} ${quotedValue.toLocaleString()}`, href: "/app/finance/invoices" },
    { k: "Sent quotations", v: sent?.length ?? 0, href: "/app/finance/invoices" },
    { k: "Open price confirmations", v: openPrice ?? 0, href: "/app/finance/price-requests" },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Finance</h1>
        <p className="muted mt-1">Quotations, invoices, approvals and Excel exports — your own accounting core.</p>
      </div>
      <div className="grid cols-3">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v" style={{ fontSize: "1.5rem" }}>{t.v}</div>
          </Link>
        ))}
      </div>
      <div className="grid cols-3">
        <Link href="/app/finance/invoices" className="card"><div className="card-title">🧾 Invoices</div><p className="card-sub">Billing documents from quotations.</p></Link>
        <Link href="/app/finance/price-requests" className="card"><div className="card-title">❓ Price Confirmations</div><p className="card-sub">Confirm prices routed to finance.</p></Link>
        <Link href="/app/finance/exports" className="card"><div className="card-title">📊 Excel Exports</div><p className="card-sub">Download logs as Excel-compatible CSV.</p></Link>
      </div>
    </div>
  );
}
