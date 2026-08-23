/**
 * FIN-007 — Funding requirements and investments.
 * Lists funding gaps derived from the cash forecast, funding requirements, and the investment register.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { dec, decGtZero, decSub, decSum, fmtMoney } from "@/lib/money";
import { projectCash, type CashFlowItem } from "@/management/ai-manager/forecast";
import { buildCommitmentOutflows } from "@/modules/finance/commitment-outflows";
import { computeCashPosition } from "@/modules/finance/cash-position";
import { computeFundingGap, computeInvestmentEconomics, suggestFundingRequirementName } from "@/modules/finance/funding";
import { Icon } from "@/components/Icon";
import { createFundingRequirement, createInvestment, updateFundingRequirementStatus, disposeInvestment } from "./actions";

export const metadata = { title: "Funding & Investments — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function FundingPage() {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();

  const [fundingReqs, investments, bankAccounts, invoices, bills, purchaseOrders, commitments] = await Promise.all([
    safe<any>(() => db.from("funding_requirements").select("*").eq("company_id", p.companyId).order("required_by_date") as any),
    safe<any>(() => db.from("investments").select("*").eq("company_id", p.companyId).order("acquisition_date") as any),
    safe<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", p.companyId) as any),
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
    safe<any>(() =>
      db
        .from("purchase_orders")
        .select("id, currency, total_amount, expected_payment_date, status")
        .eq("company_id", p.companyId)
        .in("status", ["open", "partially_received"]) as any,
    ),
    safe<any>(() =>
      db
        .from("commitments")
        .select("id, currency, expected_settlement_date, balance")
        .eq("company_id", p.companyId)
        .in("status", ["open", "partially_settled"]) as any,
    ),
  ]);

  const currency = invoices[0]?.currency ?? bills[0]?.currency ?? purchaseOrders[0]?.currency ?? commitments[0]?.currency ?? bankAccounts[0]?.currency ?? "LKR";
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  const cashPosition = computeCashPosition(
    bankAccounts.map((a: any) => ({ id: a.id, name: a.name, currency: a.currency, openingBalance: String(a.opening_balance ?? 0) })),
    [],
  );
  const cashTotal = cashPosition.totalsByCurrency[currency] ?? "0";

  const commitmentOutflows = buildCommitmentOutflows({
    purchaseOrders,
    commitments,
    currency,
    now,
    horizonDays: 90,
  });

  const forecast = projectCash({
    currency,
    openingCash: cashTotal,
    inflows: invoices
      .map((r: any): CashFlowItem => ({ date: r.due_date ?? today, amount: decSub(r.total_amount, r.amount_settled).toFixed() }))
      .filter((i: CashFlowItem) => decGtZero(i.amount)),
    outflows: [
      ...bills
        .map((r: any): CashFlowItem => ({ date: r.due_date ?? today, amount: decSub(r.total_amount, r.amount_settled).toFixed() }))
        .filter((o: CashFlowItem) => decGtZero(o.amount)),
      ...commitmentOutflows.map((c) => ({ date: c.date, amount: c.amount })),
    ],
    horizonDays: 90,
  });

  const gap = computeFundingGap(forecast);
  const fmt = (v: string) => fmtMoney(v, currency);

  const statusBadge = (status: string) => {
    const map: Record<string, string> = { draft: "info", requested: "warn", approved: "ok", rejected: "danger", funded: "ok" };
    return <span className={`badge ${map[status] ?? "info"}`}>{status}</span>;
  };

  return (
    <div className="stack gap-3">
      <div>
        <h1>Funding & investments</h1>
        <p className="muted mt-1">Funding gap from the forecast and the investment register.</p>
      </div>

      <div className="grid cols-2">
        <div className="card stat">
          <div className="k">90-day cash forecast lowest</div>
          <div className="v" style={{ fontSize: "1.5rem", color: forecast.goesNegative ? "var(--danger)" : "var(--ok)" }}>
            {fmt(forecast.lowest.balance)}
          </div>
          <div className="d dim">On {forecast.lowest.date}</div>
        </div>
        <div className="card stat">
          <div className="k">Derived funding gap</div>
          <div className="v" style={{ fontSize: "1.5rem", color: gap.goesNegative ? "var(--danger)" : "var(--ok)" }}>
            {gap.goesNegative ? fmt(gap.amount) : "None"}
          </div>
          <div className="d dim">{gap.goesNegative ? `Shortfall on ${gap.date}` : "Forecast stays positive"}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">New funding requirement</div>
        <form action={createFundingRequirement} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Requirement name" defaultValue={gap.goesNegative ? suggestFundingRequirementName(gap.date) : ""} required />
          <input name="description" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Description" />
          <input name="required_amount" className="input" style={{ width: 120 }} placeholder="Amount" defaultValue={gap.goesNegative ? gap.amount : ""} required />
          <input name="currency" className="input" style={{ width: 70 }} placeholder="LKR" defaultValue={currency} maxLength={3} required />
          <input name="required_by_date" className="input" style={{ width: 150 }} type="date" defaultValue={gap.date} />
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Funding requirements ({fundingReqs.length})</div>
        {fundingReqs.length === 0 ? (
          <div className="empty">No funding requirements recorded.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Name</th><th className="num">Required</th><th>By</th><th>Status</th><th>Source</th><th></th></tr>
              </thead>
              <tbody>
                {fundingReqs.map((r: any) => (
                  <tr key={r.id}>
                    <td><strong>{r.name}</strong>{r.description ? <div className="small dim">{r.description}</div> : null}</td>
                    <td className="num mono">{fmtMoney(String(r.required_amount), r.currency)}</td>
                    <td className="dim">{r.required_by_date ?? "—"}</td>
                    <td>{statusBadge(r.status)}</td>
                    <td className="dim">{r.funding_source ?? "—"}</td>
                    <td>
                      <form action={updateFundingRequirementStatus} className="row gap-1">
                        <input type="hidden" name="id" value={r.id} />
                        <select name="status" className="input sm" defaultValue={r.status}>
                          <option value="draft">draft</option>
                          <option value="requested">requested</option>
                          <option value="approved">approved</option>
                          <option value="rejected">rejected</option>
                          <option value="funded">funded</option>
                        </select>
                        <input name="funding_source" className="input sm" placeholder="Source" defaultValue={r.funding_source ?? ""} />
                        <button className="btn sm" type="submit">Update</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">New investment</div>
        <form action={createInvestment} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Investment name" required />
          <input name="kind" className="input" style={{ width: 120 }} placeholder="Kind" />
          <input name="cost_basis" className="input" style={{ width: 120 }} placeholder="Cost basis" required />
          <input name="currency" className="input" style={{ width: 70 }} placeholder="LKR" defaultValue={currency} maxLength={3} required />
          <input name="acquisition_date" className="input" style={{ width: 150 }} type="date" />
          <input name="location" className="input" style={{ width: 140 }} placeholder="Location / custodian" />
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Investments ({investments.length})</div>
        {investments.length === 0 ? (
          <div className="empty">No investments recorded.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Kind</th><th className="num">Cost basis</th><th className="num">Current / proceeds</th><th className="num">Gain / loss</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {investments.map((inv: any) => {
                  const econ = computeInvestmentEconomics(inv);
                  return (
                    <tr key={inv.id}>
                      <td><strong>{inv.name}</strong>{inv.location ? <div className="small dim">{inv.location}</div> : null}</td>
                      <td className="dim">{inv.kind ?? "—"}</td>
                      <td className="num mono">{fmtMoney(econ.costBasis, inv.currency)}</td>
                      <td className="num mono">{fmtMoney(econ.currentValue, inv.currency)}</td>
                      <td className="num mono">
                        {econ.realizedGainOrLoss !== null
                          ? fmtMoney(econ.realizedGainOrLoss, inv.currency)
                          : fmtMoney(econ.unrealizedGainOrLoss, inv.currency)}
                      </td>
                      <td><span className={`badge ${inv.status === "active" ? "ok" : "info"}`}>{inv.status}</span></td>
                      <td>
                        {inv.status === "active" ? (
                          <form action={disposeInvestment} className="row gap-1">
                            <input type="hidden" name="id" value={inv.id} />
                            <input name="disposal_proceeds" className="input sm" placeholder="Proceeds" required />
                            <input name="disposal_date" className="input sm" type="date" defaultValue={today} required />
                            <button className="btn sm" type="submit">Dispose</button>
                          </form>
                        ) : (
                          <span className="small dim">{inv.disposal_date ?? "—"}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Link href="/app/finance" className="btn ghost">← Finance home</Link>
    </div>
  );
}
