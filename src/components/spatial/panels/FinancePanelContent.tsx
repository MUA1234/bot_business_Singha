import Link from "next/link";
import { Icon } from "@/components/Icon";
import { fmtMoney } from "@/lib/money";
import { BarChart, type BarDatum } from "@/components/charts";
import { Card, CardHeader, CardBody } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

export type PlainObject = Record<string, unknown>;

interface FinancePanelData {
  currency: string;
  quotedValue: string;
  sentCount: number;
  openPrice: number | null;
  duplicatesUnavailable: boolean;
  pausedDuplicates: number;
  arTotal: string;
  arOverdue: string;
  arD90Plus: string;
  apTotal: string;
  apOverdue: string;
  apD90Plus: string;
  arBars: BarDatum[];
  apBars: BarDatum[];
}

export function FinancePanelContent({
  data,
  embedded,
}: {
  data: PlainObject;
  embedded?: boolean;
}) {
  const {
    currency,
    quotedValue,
    sentCount,
    openPrice,
    duplicatesUnavailable,
    pausedDuplicates,
    arTotal,
    arOverdue,
    arD90Plus,
    apTotal,
    apOverdue,
    apD90Plus,
    arBars,
    apBars,
  } = data as unknown as FinancePanelData;

  const tiles = [
    { k: "Quoted value (sent)", v: fmtMoney(quotedValue, currency), href: "/app/finance/invoices" },
    { k: "Sent quotations", v: sentCount, href: "/app/finance/invoices" },
    { k: "Open price confirmations", v: openPrice ?? 0, href: "/app/finance/price-requests" },
    {
      k: "Paused — suspected duplicates",
      v: duplicatesUnavailable ? "unknown" : pausedDuplicates,
      href: "/app/finance/duplicate-reviews",
    },
  ];

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div>
          <h1>Finance</h1>
          <p className="muted mt-1">Quotations, invoices, approvals and Excel exports — your own accounting core.</p>
        </div>
      )}
      <div className="grid cols-3">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat">
            <div className="k">{t.k}</div>
            <div className="v" style={{ fontSize: "1.5rem" }}>{typeof t.v === "number" ? fmtNumber(t.v) : t.v}</div>
          </Link>
        ))}
      </div>

      <div className="grid cols-2">
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Receivables outstanding</div>
          <div className="v" style={{ fontSize: "1.5rem", color: "var(--ok)" }}>{fmtMoney(arTotal, currency)}</div>
          <div className="d dim">Overdue: {fmtMoney(arOverdue, currency)} · 90+: {fmtMoney(arD90Plus, currency)}</div>
        </Link>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Payables outstanding</div>
          <div className="v" style={{ fontSize: "1.5rem", color: "var(--warn)" }}>{fmtMoney(apTotal, currency)}</div>
          <div className="d dim">Overdue: {fmtMoney(apOverdue, currency)} · 90+: {fmtMoney(apD90Plus, currency)}</div>
        </Link>
      </div>

      <Card>
        <CardHeader
          title="Receivables vs payables — by age"
          subtitle="Chase the amber and red receivable buckets first — the oldest debt is the hardest to collect."
        />
        <CardBody>
          <div className="small dim" style={{ marginBottom: 2 }}>Receivables (owed to you)</div>
          <BarChart data={arBars} height={120} />
          <div className="small dim" style={{ marginTop: 8, marginBottom: 2 }}>Payables (you owe)</div>
          <BarChart data={apBars} height={120} />
        </CardBody>
      </Card>

      <div className="grid cols-3">
        <Link href="/app/finance/budgets">
          <Card>
            <div className="card-title row gap-1"><Icon name="pie-chart" size={17} /> Budgets vs actual</div>
            <p className="card-sub">Build budgets and compare them to journal activity and scenarios.</p>
          </Card>
        </Link>
        <Link href="/app/finance/invoices">
          <Card>
            <div className="card-title row gap-1"><Icon name="file-text" size={17} /> Invoices</div>
            <p className="card-sub">Billing documents from quotations.</p>
          </Card>
        </Link>
        <Link href="/app/finance/price-requests">
          <Card>
            <div className="card-title row gap-1"><Icon name="help-circle" size={17} /> Price Confirmations</div>
            <p className="card-sub">Confirm prices routed to finance.</p>
          </Card>
        </Link>
        <Link href="/app/finance/exports">
          <Card>
            <div className="card-title row gap-1"><Icon name="table" size={17} /> Excel Exports</div>
            <p className="card-sub">Download logs as Excel-compatible CSV.</p>
          </Card>
        </Link>
        <Link href="/app/finance/funding">
          <Card>
            <div className="card-title row gap-1"><Icon name="target" size={17} /> Funding & investments</div>
            <p className="card-sub">Funding gap from the forecast and the investment register.</p>
          </Card>
        </Link>
      </div>
    </div>
  );
}
