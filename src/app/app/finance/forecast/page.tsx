/**
 * Cash forecast (§8.5). Projects the cash balance across 90 days from current cash
 * (computeCashPosition) plus expected inflows (unpaid customer invoices, on due date)
 * and outflows (unpaid supplier bills). Read-only, company-scoped, decimal money.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, decGtZero, decSub, fmtMoney } from "@/lib/money";
import { computeCashPosition, type CashAccount, type CashMovement } from "@/modules/finance/cash-position";
import { projectCash, type CashFlowItem } from "@/management/ai-manager/forecast";
import { expandRecurring, type Cadence } from "@/modules/finance/recurring";
import { AreaLineChart } from "@/components/charts";

export const metadata = { title: "Cash Forecast — Singha" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

const today = () => new Date().toISOString().slice(0, 10);

export default async function ForecastPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [banks, cashes, pmts, invoices, bills, commitments, recurring] = await Promise.all([
    safe<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("cash_accounts").select("id, name, currency, opening_balance").eq("company_id", p.companyId) as any),
    safe<any>(() => db.from("payments").select("direction, amount, bank_account_id, cash_account_id, status").eq("company_id", p.companyId).neq("status", "void") as any),
    safe<any>(() => db.from("customer_invoices").select("currency, total_amount, amount_settled, due_date, status").eq("company_id", p.companyId).not("status", "in", "(paid,cancelled)") as any),
    safe<any>(() => db.from("supplier_bills").select("currency, total_amount, amount_settled, due_date, status").eq("company_id", p.companyId).not("status", "in", "(paid,cancelled)") as any),
    safe<any>(() => db.from("commitments").select("amount, expected_settlement_date, status").eq("company_id", p.companyId).eq("status", "open") as any),
    safe<any>(() => db.from("recurring_obligations").select("amount, cadence, next_due").eq("company_id", p.companyId) as any),
  ]);

  const currency = invoices[0]?.currency ?? bills[0]?.currency ?? banks[0]?.currency ?? "LKR";

  const cashAccounts: CashAccount[] = [...banks, ...cashes]
    .filter((a) => a.currency === currency)
    .map((a) => ({ id: a.id, name: a.name, currency: a.currency, openingBalance: String(a.opening_balance ?? 0) }));
  const movements: CashMovement[] = pmts
    .map((m): CashMovement | null => {
      const accountId = m.bank_account_id ?? m.cash_account_id;
      return accountId ? { accountId, direction: m.direction === "in" ? "in" : "out", amount: String(m.amount ?? 0) } : null;
    })
    .filter((m): m is CashMovement => m !== null);
  const openingCash = computeCashPosition(cashAccounts, movements).totalsByCurrency[currency] ?? "0";

  const outstanding = (r: any) => decSub(r.total_amount, r.amount_settled).toFixed();
  const inflows: CashFlowItem[] = invoices.filter((r) => decGtZero(outstanding(r))).map((r) => ({ date: r.due_date ?? today(), amount: outstanding(r) }));

  const now = new Date();
  const outflows: CashFlowItem[] = [
    ...bills.filter((r) => decGtZero(outstanding(r))).map((r) => ({ date: r.due_date ?? today(), amount: outstanding(r) })),
    // One-off commitments (rent deposits, contracted spend).
    ...commitments.filter((c) => decGtZero(c.amount)).map((c): CashFlowItem => ({ date: c.expected_settlement_date ?? today(), amount: String(c.amount) })),
    // Recurring obligations (rent, salaries) expanded across the 90-day horizon.
    ...recurring.flatMap((r) => (r.next_due ? expandRecurring(r.cadence as Cadence, String(r.amount ?? 0), r.next_due, 90, now) : [])),
  ];

  const fc = projectCash({ currency, openingCash, inflows, outflows, horizonDays: 90 });
  const fmt = (v: string) => fmtMoney(v, currency);

  // Sample the curve at 0/30/60/90 days for a compact view.
  const sample = [0, 30, 60, 90].map((d) => fc.points[Math.min(d, fc.points.length - 1)]).filter(Boolean);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Cash Forecast</h1>
          <p className="muted mt-1">90-day projection from current cash, expected receipts and payments.</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance">← Finance</Link>
      </div>

      {fc.goesNegative && (
        <div className="notice err">⚠️ Cash is projected to go negative — trough {fmt(fc.lowest.balance)} on {fc.lowest.date}. Act on collections or delay outflows.</div>
      )}

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Opening cash</div><div className="v" style={{ fontSize: "1.4rem" }}>{fmt(openingCash)}</div></div>
        <div className="card stat"><div className="k">Projected close (90d)</div><div className="v" style={{ fontSize: "1.4rem", color: fc.goesNegative ? "var(--danger)" : "var(--ok)" }}>{fmt(fc.closingBalance)}</div></div>
        <div className="card stat"><div className="k">Lowest point</div><div className="v" style={{ fontSize: "1.4rem", color: dec(fc.lowest.balance).isNegative() ? "var(--danger)" : "var(--info)" }}>{fmt(fc.lowest.balance)}</div><div className="d dim">{fc.lowest.date}</div></div>
      </div>

      <div className="card">
        <div className="card-title">Projected cash — full 90-day curve</div>
        <div className="card-sub">The marked point is the trough — pull collections earlier or push payments later to lift it.</div>
        <div className="mt-2">
          <AreaLineChart points={fc.points.map((p) => ({ label: p.date.slice(5), value: dec(p.balance).toNumber(), display: fmt(p.balance) }))} />
        </div>
        {fc.goesNegative && (
          <div className="small mt-1" style={{ color: "var(--danger)" }}>
            ⚠ Projection crosses below zero — trough {fmt(fc.lowest.balance)} on {fc.lowest.date}.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Projected balance</div>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Date</th><th className="num">Balance</th></tr></thead>
            <tbody>
              {sample.map((pt) => (
                <tr key={pt!.date}><td className="dim small">{pt!.date}</td><td className="num">{fmt(pt!.balance)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="card-sub mt-2">Inflows from {inflows.length} open invoice(s); {outflows.length} scheduled outflow(s) (bills, commitments &amp; recurring).</p>
      </div>
    </div>
  );
}
