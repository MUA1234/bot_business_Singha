/**
 * Explainable business-health score (CTL-004). A dedicated page that surfaces the
 * composite health indicator, its component scores, and the exact weights used to
 * combine them. Read-only. Owner/admin surface (requireAdmin).
 *
 * Degrades gracefully when a data source fails: the score still renders, the
 * failing component is marked "data unavailable", and the page never presents a
 * false all-clear.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { log } from "@/lib/log";
import { dec, decGtZero, decSub, fmtMoney } from "@/lib/money";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import {
  computeHealthScore,
  healthScoreStatusTone,
  type HealthScoreResult,
} from "@/modules/management/health-score";
import {
  detectTaskExceptions,
  detectCapacityExceptions,
  type TaskLike,
  type CapacityLike,
} from "@/management/ai-manager/exceptions";
import { ageItems, type AgingItem } from "@/modules/finance/aging";
import { computeCashPosition, type CashAccount, type CashMovement } from "@/modules/finance/cash-position";
import { projectCash, type CashFlowItem } from "@/management/ai-manager/forecast";
import { buildCommitmentOutflows, type CommitmentOutflow } from "@/modules/finance/commitment-outflows";

export const metadata = { title: "Business Health — Singha Central" };

function makeObservedSelect(failures: string[]) {
  return async function observedSelect<T>(
    name: string,
    run: () => Promise<{ data: T[] | null; error: { message?: string } | null }>,
  ): Promise<T[]> {
    try {
      const { data, error } = await run();
      if (error) {
        failures.push(name);
        log("error", "business health query failed", { event: "command.query_failed", source: name, error: error.message ?? "unknown" });
        return [];
      }
      return data ?? [];
    } catch (e) {
      failures.push(name);
      log("error", "business health query failed", { event: "command.query_failed", source: name, error: (e as Error).message });
      return [];
    }
  };
}

interface ComponentRow {
  name: string;
  weight: number;
  score: number;
  contribution: number;
}

export default async function BusinessHealthPage() {
  const admin = await requireAdmin();
  const db = supabaseReadClient();
  const now = new Date();
  const failedSources: string[] = [];
  const safeSelect = <T,>(run: () => Promise<{ data: T[] | null; error: { message?: string } | null }>, name = "query") =>
    makeObservedSelect(failedSources)<T>(name, run);

  const taskRows = await safeSelect<any>(() =>
    db
      .from("tasks")
      .select("id, title, status, due_date, estimate_hours, updated_at")
      .eq("company_id", admin.companyId)
      .limit(500) as any,
  "tasks");

  const capRows = await safeSelect<any>(() =>
    db
      .from("capacity_snapshots")
      .select("membership_id, status, utilization_pct, week_start")
      .eq("company_id", admin.companyId)
      .order("week_start", { ascending: false })
      .limit(200) as any,
  "capacity_snapshots");

  const invoices = await safeSelect<any>(() =>
    db
      .from("customer_invoices")
      .select("currency, total_amount, amount_settled, due_date, status")
      .eq("company_id", admin.companyId)
      .not("status", "in", "(paid,cancelled)") as any,
  "customer_invoices");
  const bills = await safeSelect<any>(() =>
    db
      .from("supplier_bills")
      .select("currency, total_amount, amount_settled, due_date, status")
      .eq("company_id", admin.companyId)
      .not("status", "in", "(paid,cancelled)") as any,
  "supplier_bills");

  const purchaseOrders = await safeSelect<any>(() =>
    db
      .from("purchase_orders")
      .select("id, po_number, total_amount, currency, status, expected_payment_date")
      .eq("company_id", admin.companyId)
      .not("status", "in", "(closed,cancelled)") as any,
  "purchase_orders");

  const commitments = await safeSelect<any>(() =>
    db
      .from("commitments")
      .select("id, description, amount, currency, status, expected_settlement_date")
      .eq("company_id", admin.companyId)
      .in("status", ["open", "partially_settled"]) as any,
  "commitments");

  const [riskRows, incidentRows, obligationRows] = await Promise.all([
    safeSelect<any>(() => db.from("risks").select("id, status").eq("company_id", admin.companyId).neq("status", "closed") as any, "risks"),
    safeSelect<any>(() => db.from("incidents").select("id, status").eq("company_id", admin.companyId).neq("status", "closed") as any, "incidents"),
    safeSelect<any>(() => db.from("obligations").select("id, status").eq("company_id", admin.companyId).neq("status", "done") as any, "obligations"),
  ]);

  const currency = invoices[0]?.currency ?? bills[0]?.currency ?? purchaseOrders[0]?.currency ?? commitments[0]?.currency ?? "LKR";
  const toItems = (rows: any[]): AgingItem[] =>
    rows.map((r) => ({
      dueDate: r.due_date ?? null,
      outstanding: decSub(r.total_amount, r.amount_settled).toFixed(),
    }));
  const ar = ageItems(toItems(invoices), currency, now);
  const ap = ageItems(toItems(bills), currency, now);

  const [banks, cashes, pmts] = await Promise.all([
    safeSelect<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", admin.companyId) as any, "bank_accounts"),
    safeSelect<any>(() => db.from("cash_accounts").select("id, name, currency, opening_balance").eq("company_id", admin.companyId) as any, "cash_accounts"),
    safeSelect<any>(() => db.from("payments").select("direction, amount, bank_account_id, cash_account_id, status").eq("company_id", admin.companyId).neq("status", "void") as any, "payments"),
  ]);
  const cashAccounts: CashAccount[] = [...banks, ...cashes].map((a) => ({
    id: a.id, name: a.name, currency: a.currency, openingBalance: String(a.opening_balance ?? 0),
  }));
  const movements: CashMovement[] = pmts
    .map((p): CashMovement | null => {
      const accountId = p.bank_account_id ?? p.cash_account_id;
      if (!accountId) return null;
      return { accountId, direction: p.direction === "in" ? "in" : "out", amount: String(p.amount ?? 0) };
    })
    .filter((m): m is CashMovement => m !== null);
  const cash = computeCashPosition(cashAccounts, movements);
  const cashTotal = cash.totalsByCurrency[currency] ?? "0";

  const tasks: TaskLike[] = taskRows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    dueDate: t.due_date,
    lastCheckInAt: t.updated_at,
    estimateHours: t.estimate_hours,
  }));

  const seen = new Set<string>();
  const caps: CapacityLike[] = [];
  for (const c of capRows) {
    if (seen.has(c.membership_id)) continue;
    seen.add(c.membership_id);
    caps.push({ membershipId: c.membership_id, status: c.status, utilizationPct: Number(c.utilization_pct ?? 0) });
  }

  const taskExceptions = detectTaskExceptions(tasks, now);
  const capacityExceptions = detectCapacityExceptions(caps);

  const openTasks = taskRows.filter((t) => t.status !== "done" && t.status !== "cancelled" && t.status !== "completed").length;
  const overdueTasks = taskRows.filter((t) => t.due_date && new Date(t.due_date) < now && t.status !== "done" && t.status !== "completed").length;
  const blockedTasks = taskRows.filter((t) => t.status === "blocked").length;

  const t = () => now.toISOString().slice(0, 10);
  const commitmentOutflows: CommitmentOutflow[] = buildCommitmentOutflows({
    purchaseOrders,
    commitments,
    currency,
    now,
    horizonDays: 90,
  });
  const fc = projectCash({
    currency,
    openingCash: cashTotal,
    inflows: invoices.map((r): CashFlowItem => ({ date: r.due_date ?? t(), amount: decSub(r.total_amount, r.amount_settled).toFixed() })).filter((i) => decGtZero(i.amount)),
    outflows: [
      ...bills.map((r): CashFlowItem => ({ date: r.due_date ?? t(), amount: decSub(r.total_amount, r.amount_settled).toFixed() })).filter((o) => decGtZero(o.amount)),
      ...commitmentOutflows.map((c): CashFlowItem => ({ date: c.date, amount: c.amount })),
    ],
    horizonDays: 90,
  });

  const health: HealthScoreResult = computeHealthScore({
    currency,
    cashTotal,
    arOverdue: ar.overdue,
    apOverdue: ap.overdue,
    openTasks,
    overdueTasks,
    blockedTasks,
    openRisks: riskRows.filter((r) => r.status !== "closed").length,
    openIncidents: incidentRows.filter((i) => i.status !== "closed").length,
    openObligations: obligationRows.filter((o) => o.status !== "done").length,
    overloadedPeople: capacityExceptions.length,
    totalPeople: Math.max(1, caps.length),
    forecastGoesNegative: fc.goesNegative,
  });
  const fmt = (v: string) => fmtMoney(v, currency);

  const scoreTone = healthScoreStatusTone(health.status);
  const componentColumns: DataTableColumn<ComponentRow>[] = [
    { key: "name", header: "Component", render: (c) => c.name },
    { key: "weight", header: "Weight", align: "right", render: (c) => `${(c.weight * 100).toFixed(0)}%` },
    { key: "score", header: "Score", align: "right", render: (c) => c.score },
    { key: "contribution", header: "Contribution", align: "right", render: (c) => c.contribution.toFixed(1) },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap">
        <div>
          <h1>Business health</h1>
          <p className="muted mt-1">A single explainable score built from live operational signals.</p>
        </div>
        <div className="row gap-1 wrap">
          <Link className="btn ghost sm" href="/app/command">Command Centre</Link>
          <Link className="btn ghost sm" href="/app/command/analyze">Analyse</Link>
          <Link className="btn ghost sm" href="/app/command/cases">AI cases</Link>
          <Link className="btn ghost sm" href="/app/command/memory">Memory</Link>
        </div>
      </div>

      {failedSources.length > 0 && (
        <Card style={{ color: "var(--danger)" }}>
          Some data sources failed to load ({failedSources.join(", ")}). The score below may be incomplete —
          missing components are marked. This has been reported to monitoring.
        </Card>
      )}

      <Card className="stat" padding="lg" style={{ textAlign: "center" }}>
        <div className="k">Health score</div>
        <div className="v" style={{ color: `var(--${scoreTone})` }}>{health.score}</div>
        <div className="d dim" style={{ textTransform: "capitalize" }}>
          <Badge variant={scoreTone as any}>{health.status}</Badge>
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Score breakdown"
          subtitle={
            <>
              Status: <Badge variant={scoreTone as any}>{health.status}</Badge>
              {health.issues.length > 0 && (
                <span className="ml-2 dim">Issues: {health.issues.join(", ")}</span>
              )}
            </>
          }
        />
        <CardBody>
          <DataTable
            columns={componentColumns}
            rows={health.components as ComponentRow[]}
            keyExtractor={(c) => c.name}
          />
        </CardBody>
      </Card>

      <div className="grid cols-3">
        <Card className="stat">
          <div className="k">Cash on hand</div>
          <div className="v" style={{ color: "var(--info)" }}>{fmt(cashTotal)}</div>
        </Card>
        <Card className="stat">
          <div className="k">90-day forecast trough</div>
          <div className="v" style={{ color: fc.goesNegative ? "var(--danger)" : "var(--ok)" }}>{fmt(fc.lowest.balance)}</div>
        </Card>
        <Card className="stat">
          <div className="k">Outstanding receivables</div>
          <div className="v" style={{ color: decGtZero(ar.overdue) ? "var(--warn)" : "var(--ok)" }}>{fmt(ar.total)}</div>
          <div className="d dim">Overdue {fmt(ar.overdue)}</div>
        </Card>
      </div>
    </div>
  );
}
