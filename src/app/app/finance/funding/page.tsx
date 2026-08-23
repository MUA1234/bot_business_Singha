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
import { Card, CardHeader, CardBody, Button, Badge, StatusBadge, DataTable, type DataTableColumn } from "@/components/ui";
import type { BadgeVariant } from "@/components/ui/Badge";
import { fmtDate } from "@/lib/format";
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

  const statusVariant = (status: string): BadgeVariant => {
    const map: Record<string, BadgeVariant> = { draft: "info", requested: "warn", approved: "ok", rejected: "danger", funded: "ok" };
    return map[status] ?? "info";
  };

  const fundingColumns: DataTableColumn<(typeof fundingReqs)[number]>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) => (
        <span>
          <strong>{r.name}</strong>
          {r.description ? <div className="small dim">{r.description}</div> : null}
        </span>
      ),
    },
    { key: "required", header: "Required", align: "right", render: (r) => <span className="mono">{fmtMoney(String(r.required_amount), r.currency)}</span> },
    { key: "by", header: "By", render: (r) => <span className="dim">{fmtDate(r.required_by_date) ?? "—"}</span> },
    { key: "status", header: "Status", render: (r) => <Badge variant={statusVariant(r.status)}>{r.status}</Badge> },
    { key: "source", header: "Source", render: (r) => <span className="dim">{r.funding_source ?? "—"}</span> },
    {
      key: "action",
      header: "",
      render: (r) => (
        <form action={updateFundingRequirementStatus} className="row gap-1 wrap">
          <input type="hidden" name="id" value={r.id} />
          <select name="status" className="input sm" defaultValue={r.status}>
            <option value="draft">draft</option>
            <option value="requested">requested</option>
            <option value="approved">approved</option>
            <option value="rejected">rejected</option>
            <option value="funded">funded</option>
          </select>
          <input name="funding_source" className="input sm" placeholder="Source" defaultValue={r.funding_source ?? ""} />
          <Button size="sm" type="submit">Update</Button>
        </form>
      ),
    },
  ];

  const investmentColumns: DataTableColumn<(typeof investments)[number]>[] = [
    {
      key: "name",
      header: "Name",
      render: (inv) => (
        <span>
          <strong>{inv.name}</strong>
          {inv.location ? <div className="small dim">{inv.location}</div> : null}
        </span>
      ),
    },
    { key: "kind", header: "Kind", render: (inv) => <span className="dim">{inv.kind ?? "—"}</span> },
    { key: "costBasis", header: "Cost basis", align: "right", render: (inv) => <span className="mono">{fmtMoney(computeInvestmentEconomics(inv).costBasis, inv.currency)}</span> },
    { key: "currentValue", header: "Current / proceeds", align: "right", render: (inv) => <span className="mono">{fmtMoney(computeInvestmentEconomics(inv).currentValue, inv.currency)}</span> },
    {
      key: "gain",
      header: "Gain / loss",
      align: "right",
      render: (inv) => {
        const econ = computeInvestmentEconomics(inv);
        return <span className="mono">{econ.realizedGainOrLoss !== null ? fmtMoney(econ.realizedGainOrLoss, inv.currency) : fmtMoney(econ.unrealizedGainOrLoss, inv.currency)}</span>;
      },
    },
    { key: "status", header: "Status", render: (inv) => <StatusBadge status={inv.status} /> },
    {
      key: "action",
      header: "",
      render: (inv) => inv.status === "active" ? (
        <form action={disposeInvestment} className="row gap-1 wrap">
          <input type="hidden" name="id" value={inv.id} />
          <input name="disposal_proceeds" className="input sm" placeholder="Proceeds" required />
          <input name="disposal_date" className="input sm" type="date" defaultValue={today} required />
          <Button size="sm" type="submit">Dispose</Button>
        </form>
      ) : (
        <span className="small dim">{fmtDate(inv.disposal_date) ?? "—"}</span>
      ),
    },
  ];

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

      <Card>
        <CardHeader title="New funding requirement" />
        <CardBody>
          <form action={createFundingRequirement} className="row gap-1 wrap">
            <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Requirement name" defaultValue={gap.goesNegative ? suggestFundingRequirementName(gap.date) : ""} required />
            <input name="description" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Description" />
            <input name="required_amount" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Amount" defaultValue={gap.goesNegative ? gap.amount : ""} required />
            <input name="currency" className="input" style={{ flex: "0 0 70px", minWidth: 60 }} placeholder="LKR" defaultValue={currency} maxLength={3} required />
            <input name="required_by_date" className="input" style={{ flex: "0 0 150px", minWidth: 130 }} type="date" defaultValue={gap.date} />
            <Button type="submit">Create</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Funding requirements (${fundingReqs.length})`} />
        <CardBody>
          <DataTable columns={fundingColumns} rows={fundingReqs} keyExtractor={(r) => r.id} emptyTitle="No funding requirements recorded" />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="New investment" />
        <CardBody>
          <form action={createInvestment} className="row gap-1 wrap">
            <input name="name" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Investment name" required />
            <input name="kind" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Kind" />
            <input name="cost_basis" className="input" style={{ flex: "0 0 120px", minWidth: 100 }} placeholder="Cost basis" required />
            <input name="currency" className="input" style={{ flex: "0 0 70px", minWidth: 60 }} placeholder="LKR" defaultValue={currency} maxLength={3} required />
            <input name="acquisition_date" className="input" style={{ flex: "0 0 150px", minWidth: 130 }} type="date" />
            <input name="location" className="input" style={{ flex: "0 0 140px", minWidth: 120 }} placeholder="Location / custodian" />
            <Button type="submit">Create</Button>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Investments (${investments.length})`} />
        <CardBody>
          <DataTable columns={investmentColumns} rows={investments} keyExtractor={(inv) => inv.id} emptyTitle="No investments recorded" />
        </CardBody>
      </Card>

      <Link href="/app/finance" className="btn ghost">← Finance home</Link>
    </div>
  );
}
