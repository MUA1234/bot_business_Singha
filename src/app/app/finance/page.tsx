import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient, supabaseRpcClient } from "@/lib/supabase/read";
import { Icon } from "@/components/Icon";
import { decSub, decSum, fmtMoney } from "@/lib/money";
import { ageItems, type AgingItem } from "@/modules/finance/aging";
import { BarChart, agingBars } from "@/components/charts";

export const metadata = { title: "Finance — Singha Central" };

/** Read-only query that never throws (missing table → []). */
async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function FinanceHome() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [{ data: sent }, { count: openPrice }, invoices, bills] = await Promise.all([
    db.from("quotations").select("total, currency, status").eq("company_id", p.companyId).eq("status", "sent"),
    db.from("price_confirmations").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "open"),
    safe<any>(() =>
      db
        .from("customer_invoices")
        .select("currency, total_amount, amount_settled, due_date, status")
        .eq("company_id", p.companyId)
        .not("status", "in", "(paid,cancelled)") as any,
    ),
    safe<any>(() =>
      db
        .from("supplier_bills")
        .select("currency, total_amount, amount_settled, due_date, status")
        .eq("company_id", p.companyId)
        .not("status", "in", "(paid,cancelled)") as any,
    ),
  ]);

  // OF-016: paused payments are backlog. A suspected duplicate has no approval request, so
  // without this tile it is invisible everywhere a person actually looks. Counted through the
  // capability-gated queue, so a member without `finance.duplicate.resolve` simply sees 0 rather
  // than a number they cannot act on.
  let pausedDuplicates = 0;
  let duplicatesUnavailable = false;
  try {
    const { data, error } = await supabaseRpcClient().rpc("duplicate_review_queue", {
      p_company: p.companyId,
    });
    if (error) duplicatesUnavailable = true;
    else {
      // Count DISTINCT paused PAYMENTS, not review rows. One payment that resembles two earlier
      // ones raises two reviews, and counting rows made the banner say "2 payments are paused"
      // when one was. The label says payments, so the number must mean payments.
      const open = ((data ?? []) as { state: string; candidate_event_id: string }[])
        .filter((r) => r.state === "open");
      pausedDuplicates = new Set(open.map((r) => r.candidate_event_id)).size;
    }
  } catch {
    duplicatesUnavailable = true;
  }

  const currency = sent?.[0]?.currency ?? invoices[0]?.currency ?? "LKR";
  const quotedValue = decSum((sent ?? []).map((q: any) => q.total));

  // Outstanding = total − settled, aged. Decimal strings throughout (Constitution §8).
  const toItems = (rows: any[]): AgingItem[] =>
    rows.map((r) => ({
      dueDate: r.due_date ?? null,
      outstanding: decSub(r.total_amount, r.amount_settled).toFixed(),
    }));
  const now = new Date();
  const ar = ageItems(toItems(invoices), currency, now);
  const ap = ageItems(toItems(bills), currency, now);
  const fmt = (v: string) => fmtMoney(v, currency);

  const tiles = [
    { k: "Quoted value (sent)", v: fmtMoney(quotedValue, currency), href: "/app/finance/invoices" },
    { k: "Sent quotations", v: sent?.length ?? 0, href: "/app/finance/invoices" },
    { k: "Open price confirmations", v: openPrice ?? 0, href: "/app/finance/price-requests" },
    {
      k: "Paused — suspected duplicates",
      v: duplicatesUnavailable ? "unknown" : pausedDuplicates,
      href: "/app/finance/duplicate-reviews",
    },
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

      <div className="grid cols-2">
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Receivables outstanding</div>
          <div className="v" style={{ fontSize: "1.5rem", color: "var(--ok)" }}>{fmtMoney(ar.total, currency)}</div>
          <div className="d dim">Overdue: {fmtMoney(ar.overdue, currency)} · 90+: {fmtMoney(ar.buckets.d90_plus)}</div>
        </Link>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Payables outstanding</div>
          <div className="v" style={{ fontSize: "1.5rem", color: "var(--warn)" }}>{fmtMoney(ap.total, currency)}</div>
          <div className="d dim">Overdue: {fmtMoney(ap.overdue, currency)} · 90+: {fmtMoney(ap.buckets.d90_plus)}</div>
        </Link>
      </div>

      <div className="card">
        <div className="card-title">Receivables vs payables — by age</div>
        <div className="card-sub">Chase the amber and red receivable buckets first — the oldest debt is the hardest to collect.</div>
        <div className="mt-2">
          <div className="small dim" style={{ marginBottom: 2 }}>Receivables (owed to you)</div>
          <BarChart data={agingBars(ar.buckets, fmt)} height={120} />
          <div className="small dim" style={{ marginTop: 8, marginBottom: 2 }}>Payables (you owe)</div>
          <BarChart data={agingBars(ap.buckets, fmt)} height={120} />
        </div>
      </div>

      <div className="grid cols-3">
        <Link href="/app/finance/budgets" className="card"><div className="card-title row gap-1"><Icon name="pie-chart" size={17} /> Budgets vs actual</div><p className="card-sub">Build budgets and compare them to journal activity and scenarios.</p></Link>
        <Link href="/app/finance/invoices" className="card"><div className="card-title row gap-1"><Icon name="file-text" size={17} /> Invoices</div><p className="card-sub">Billing documents from quotations.</p></Link>
        <Link href="/app/finance/price-requests" className="card"><div className="card-title row gap-1"><Icon name="help-circle" size={17} /> Price Confirmations</div><p className="card-sub">Confirm prices routed to finance.</p></Link>
        <Link href="/app/finance/exports" className="card"><div className="card-title row gap-1"><Icon name="table" size={17} /> Excel Exports</div><p className="card-sub">Download logs as Excel-compatible CSV.</p></Link>
      </div>
    </div>
  );
}
