/**
 * Exception-led Command Centre (Architecture V2 change plan §10.1). The FIRST wired
 * use of the AI-manager brain: it runs the pure exception detector
 * (src/management/ai-manager/exceptions.ts) over live, company-scoped task and
 * capacity data and surfaces what needs attention, ranked critical-first.
 *
 * Read-only. Owner/admin surface (requireAdmin). Degrades gracefully before the
 * Phase-1/2 migrations are applied (missing tables → empty state, never a crash).
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import {
  detectTaskExceptions,
  detectCapacityExceptions,
  sortBySeverity,
  type TaskLike,
  type CapacityLike,
  type Exception,
} from "@/management/ai-manager/exceptions";
import { ageItems, type AgingItem } from "@/modules/finance/aging";
import { computeCashPosition, type CashAccount, type CashMovement } from "@/modules/finance/cash-position";
import { dec, decGtZero, decSub, fmtMoney } from "@/lib/money";
import { log } from "@/lib/log";
import { AreaLineChart, BarChart, agingBars } from "@/components/charts";
import { projectCash, type CashFlowItem } from "@/management/ai-manager/forecast";
import { buildBriefing } from "@/management/ai-manager/briefing";
import { buildCommitmentOutflows, type CommitmentOutflow } from "@/modules/finance/commitment-outflows";

export const metadata = { title: "Command Centre — Singha Central" };

/**
 * Completion P1C — a failed query is a DEGRADED page, never a silent []. Each failure is logged
 * (telemetry: `command.query_failed`; /api/health independently probes the same tables) and recorded
 * so the page renders a user-safe degraded banner instead of a false "All clear".
 */
function makeObservedSelect(failures: string[]) {
  return async function observedSelect<T>(
    name: string,
    run: () => Promise<{ data: T[] | null; error: { message?: string } | null }>,
  ): Promise<T[]> {
    try {
      const { data, error } = await run();
      if (error) {
        failures.push(name);
        log("error", "command centre query failed", { event: "command.query_failed", source: name, error: error.message ?? "unknown" });
        return [];
      }
      return data ?? [];
    } catch (e) {
      failures.push(name);
      log("error", "command centre query failed", { event: "command.query_failed", source: name, error: (e as Error).message });
      return [];
    }
  };
}

export default async function CommandCentrePage() {
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

  const currency = invoices[0]?.currency ?? bills[0]?.currency ?? purchaseOrders[0]?.currency ?? commitments[0]?.currency ?? "LKR";
  // Outstanding = total − settled, EXACT (Decimal) — these amounts drive aging buckets, the
  // overdue exceptions below, and the cash forecast; a float subtraction drifts on both large
  // and fractional amounts.
  const toItems = (rows: any[]): AgingItem[] =>
    rows.map((r) => ({
      dueDate: r.due_date ?? null,
      outstanding: decSub(r.total_amount, r.amount_settled).toFixed(),
    }));
  const ar = ageItems(toItems(invoices), currency, now);
  const ap = ageItems(toItems(bills), currency, now);
  const fmt = (v: string) => fmtMoney(v, currency);

  // Cash position: bank + cash accounts, adjusted by non-void payments.
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
    lastCheckInAt: t.updated_at, // proxy until check-in join is wired
    estimateHours: t.estimate_hours,
  }));

  // Latest snapshot per membership only.
  const seen = new Set<string>();
  const caps: CapacityLike[] = [];
  for (const c of capRows) {
    if (seen.has(c.membership_id)) continue;
    seen.add(c.membership_id);
    caps.push({ membershipId: c.membership_id, status: c.status, utilizationPct: Number(c.utilization_pct ?? 0) });
  }

  const financeExceptions: Exception[] = [];
  if (decGtZero(ar.overdue))
    financeExceptions.push({ type: "overdue", severity: "critical", message: `Overdue receivables: ${fmt(ar.overdue)}` });
  if (decGtZero(ap.overdue))
    financeExceptions.push({ type: "overdue", severity: "warn", message: `Overdue payables: ${fmt(ap.overdue)}` });

  const exceptions: Exception[] = sortBySeverity([
    ...financeExceptions,
    ...detectTaskExceptions(tasks, now),
    ...detectCapacityExceptions(caps),
  ]);
  const count = (s: Exception["severity"]) => exceptions.filter((e) => e.severity === s).length;
  const badgeClass = (s: Exception["severity"]) => (s === "critical" ? "danger" : s === "warn" ? "warn" : "info");

  // 90-day cash forecast from open invoices (in), bills (out) and committed outflows.
  const t = () => now.toISOString().slice(0, 10);
  const commitmentOutflows: CommitmentOutflow[] = buildCommitmentOutflows({
    purchaseOrders,
    commitments,
    currency,
    now,
    horizonDays: 90,
  });
  const commitmentTotal = commitmentOutflows.reduce((s, c) => s.plus(dec(c.amount)), dec("0")).toFixed();
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
  const briefing = buildBriefing({
    criticalCount: count("critical"),
    warnCount: count("warn"),
    currency,
    cash: cashTotal,
    arOverdue: ar.overdue,
    apOverdue: ap.overdue,
    forecastGoesNegative: fc.goesNegative,
    forecastLowest: fc.lowest,
  });

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Command Centre</h1>
          <p className="muted mt-1">What needs attention now — ranked most urgent first.</p>
        </div>
        <div className="row gap-1">
          <Link className="btn ghost sm" href="/app/command/analyze">Analyse</Link>
          <Link className="btn ghost sm" href="/app/command/cases">AI cases</Link>
          <Link className="btn ghost sm" href="/app/command/memory">Memory</Link>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Today&apos;s briefing</div>
        <div className="stack gap-1 mt-2">
          {briefing.map((line, i) => (
            <div key={i} style={{ fontSize: "0.95rem" }}>{line}</div>
          ))}
        </div>
      </div>

      <div className="grid cols-3">
        <div className="card stat">
          <div className="k">Critical</div>
          <div className="v" style={{ color: "var(--danger)" }}>{count("critical")}</div>
        </div>
        <div className="card stat">
          <div className="k">Warnings</div>
          <div className="v" style={{ color: "var(--warn)" }}>{count("warn")}</div>
        </div>
        <div className="card stat">
          <div className="k">Info</div>
          <div className="v" style={{ color: "var(--info)" }}>{count("info")}</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <div className="card-title">Cash — next 90 days</div>
          <div className="card-sub">Projected from open invoices in and bills / committed outflows out. The marked point is the trough.</div>
          <div className="mt-2">
            <AreaLineChart
              points={fc.points.map((p) => ({ label: p.date.slice(5), value: dec(p.balance).toNumber(), display: fmt(p.balance) }))}
            />
          </div>
          {fc.goesNegative && (
            <div className="small mt-1" style={{ color: "var(--danger)" }}>
              ⚠ Projection crosses below zero — see the briefing.
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-title">Receivables vs payables — by age</div>
          <div className="card-sub">Older overdue money escalates from mint to amber to red.</div>
          <div className="mt-2">
            <div className="small dim" style={{ marginBottom: 2 }}>Receivables (owed to you)</div>
            <BarChart data={agingBars(ar.buckets, fmt)} height={120} />
            <div className="small dim" style={{ marginTop: 8, marginBottom: 2 }}>Payables (you owe)</div>
            <BarChart data={agingBars(ap.buckets, fmt)} height={120} />
          </div>
        </div>
      </div>

      <div className="grid cols-3">
        <div className="card stat">
          <div className="k">Cash on hand</div>
          <div className="v" style={{ fontSize: "1.4rem", color: "var(--info)" }}>{fmt(cashTotal)}</div>
          <div className="d dim">{cash.accounts.length} account(s)</div>
        </div>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Receivables outstanding</div>
          <div className="v" style={{ fontSize: "1.4rem", color: "var(--ok)" }}>{fmt(ar.total)}</div>
          <div className="d dim">Overdue {fmt(ar.overdue)}</div>
        </Link>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Payables outstanding</div>
          <div className="v" style={{ fontSize: "1.4rem", color: "var(--warn)" }}>{fmt(ap.total)}</div>
          <div className="d dim">Overdue {fmt(ap.overdue)}</div>
        </Link>
        <Link href="/app/procurement/purchase-orders" className="card stat">
          <div className="k">Expected commitments</div>
          <div className="v" style={{ fontSize: "1.4rem", color: "var(--info)" }}>{fmt(commitmentTotal)}</div>
          <div className="d dim">{commitmentOutflows.length} PO(s) / commitment(s) in forecast</div>
        </Link>
      </div>

      <div className="card">
        <div className="card-title">Needs attention</div>
        {failedSources.length > 0 && (
          <div className="row" style={{ padding: "8px 4px", color: "var(--danger)", borderBottom: "1px solid var(--panel-border)" }}>
            ⚠ Some data sources failed to load ({failedSources.join(", ")}). Figures on this page may be
            incomplete — this is a system problem, not a clean bill of health. It has been reported to
            monitoring.
          </div>
        )}
        {exceptions.length === 0 ? (
          <div className="empty">
            {failedSources.length > 0
              ? "Exception detection is degraded because data sources failed — no \"all clear\" can be given."
              : tasks.length === 0 && caps.length === 0
                ? "No task or capacity data yet. Once the Phase-1/2 tables are populated, exceptions appear here."
                : "All clear — nothing needs attention right now."}
          </div>
        ) : (
          <div className="stack gap-1 mt-2">
            {exceptions.map((e, i) => (
              <div key={i} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{e.message}</span>
                <span className={`badge ${badgeClass(e.severity)}`}>{e.type.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
