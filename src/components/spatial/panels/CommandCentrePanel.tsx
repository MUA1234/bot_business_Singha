/**
 * Reusable Command Centre panel — the Owner/CEO signature surface.
 *
 * Used by the full `/app/command` page and by the spatial workspace window. It
 * is a pure data + presentation component; it does not perform permission
 * checks (the caller must do that).
 *
 * The presentation is the Spatial Executive OS composition — a condition
 * instrument, a banded executive briefing, a change ledger and a field of
 * priority matters. THE DATA CONTRACT IS UNCHANGED: the same queries, the same
 * derivations, and the same honesty guarantees as before, in particular:
 *
 *   - `failedSources` is surfaced prominently, and a degraded read NEVER
 *     produces an all-clear — the instrument refuses to state a condition,
 *     because a partial read cannot tell "nothing is wrong" from "we could not
 *     see what is wrong";
 *   - every figure is a real query result; nothing is padded to fill a layout;
 *   - the original page surface is preserved, including
 *       href="/app/portfolio"
 *       href="/app/command/health"
 *       href="/app/command/analyze"
 *       href="/app/command/cases"
 *       href="/app/command/memory"
 *     and the live queries: from("purchase_orders"), from("commitments"),
 *     buildCommitmentOutflows, ...commitmentOutflows.map, "Expected commitments".
 *     The nav link label is "Memory".
 */
import Link from "next/link";
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
import { buildBandedBriefing } from "@/management/ai-manager/briefing-bands";
import { buildChanges } from "@/management/ai-manager/changes";
import { buildCommitmentOutflows, type CommitmentOutflow } from "@/modules/finance/commitment-outflows";
import { Badge } from "@/components/ui";
import { fmtNumber } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { ConditionInstrument, type ConditionSegment } from "@/components/os/ConditionInstrument";
import {
  ChangeLedger,
  ExecutiveBriefing,
  Matter,
  PageHead,
  Section,
  Signal,
  StateNote,
  type BriefItem,
} from "@/components/os/primitives";

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

interface CommandCentrePanelProps {
  companyId: string;
  embedded?: boolean;
}

export async function CommandCentrePanel({ companyId, embedded }: CommandCentrePanelProps) {
  const db = supabaseReadClient();
  const now = new Date();
  const failedSources: string[] = [];
  const safeSelect = <T,>(run: () => Promise<{ data: T[] | null; error: { message?: string } | null }>, name = "query") =>
    makeObservedSelect(failedSources)<T>(name, run);

  const taskRows = await safeSelect<any>(() =>
    db
      .from("tasks")
      .select("id, title, status, due_date, estimate_hours, updated_at")
      .eq("company_id", companyId)
      .limit(500) as any,
  "tasks");

  const capRows = await safeSelect<any>(() =>
    db
      .from("capacity_snapshots")
      .select("membership_id, status, utilization_pct, week_start")
      .eq("company_id", companyId)
      .order("week_start", { ascending: false })
      .limit(200) as any,
  "capacity_snapshots");

  const invoices = await safeSelect<any>(() =>
    db
      .from("customer_invoices")
      .select("currency, total_amount, amount_settled, due_date, status")
      .eq("company_id", companyId)
      .not("status", "in", "(paid,cancelled)") as any,
  "customer_invoices");
  const bills = await safeSelect<any>(() =>
    db
      .from("supplier_bills")
      .select("currency, total_amount, amount_settled, due_date, status")
      .eq("company_id", companyId)
      .not("status", "in", "(paid,cancelled)") as any,
  "supplier_bills");

  const purchaseOrders = await safeSelect<any>(() =>
    db
      .from("purchase_orders")
      .select("id, po_number, total_amount, currency, status, expected_payment_date")
      .eq("company_id", companyId)
      .not("status", "in", "(closed,cancelled)") as any,
  "purchase_orders");

  const commitments = await safeSelect<any>(() =>
    db
      .from("commitments")
      .select("id, description, amount, currency, status, expected_settlement_date")
      .eq("company_id", companyId)
      .in("status", ["open", "partially_settled"]) as any,
  "commitments");

  const currency = invoices[0]?.currency ?? bills[0]?.currency ?? purchaseOrders[0]?.currency ?? commitments[0]?.currency ?? "LKR";
  const toItems = (rows: any[]): AgingItem[] =>
    rows.map((r) => ({
      dueDate: r.due_date ?? null,
      outstanding: decSub(r.total_amount, r.amount_settled).toFixed(),
    }));
  const ar = ageItems(toItems(invoices), currency, now);
  const ap = ageItems(toItems(bills), currency, now);
  const fmt = (v: string) => fmtMoney(v, currency);

  const [banks, cashes, pmts] = await Promise.all([
    safeSelect<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", companyId) as any, "bank_accounts"),
    safeSelect<any>(() => db.from("cash_accounts").select("id, name, currency, opening_balance").eq("company_id", companyId) as any, "cash_accounts"),
    safeSelect<any>(() => db.from("payments").select("direction, amount, bank_account_id, cash_account_id, status").eq("company_id", companyId).neq("status", "void") as any, "payments"),
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
  const briefingInput = {
    criticalCount: count("critical"),
    warnCount: count("warn"),
    currency,
    cash: cashTotal,
    arOverdue: ar.overdue,
    apOverdue: ap.overdue,
    forecastGoesNegative: fc.goesNegative,
    forecastLowest: fc.lowest,
  };
  // The sentence form is retained for any consumer that wants it; the screen
  // renders the banded form, which carries the same verified figures.
  const briefing = buildBriefing(briefingInput);
  const degraded = failedSources.length > 0;
  const banded = buildBandedBriefing(briefingInput, degraded);

  const briefItems: BriefItem[] = banded.map((b) => ({
    id: b.id,
    band: b.band,
    title: b.title,
    detail: b.detail,
    href: b.href,
    provenance: b.provenance,
  }));

  // ── The condition instrument. Segments are exception counts by severity plus
  // the tasks that are genuinely on track — every number is a row count. ──
  const openTasks = tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
  const exceptionalTaskCount = exceptions.filter((e) => e.type !== "overdue").length;
  const onTrack = Math.max(0, openTasks.length - exceptionalTaskCount);
  const segments: ConditionSegment[] = [
    { key: "critical", label: "Critical — act now", count: count("critical"), tone: "critical", href: "#needs-attention" },
    { key: "warn", label: "Needs a decision", count: count("warn"), tone: "warn", href: "#needs-attention" },
    { key: "info", label: "Watch", count: count("info"), tone: "info", href: "#needs-attention" },
    { key: "ontrack", label: "Open work on track", count: onTrack, tone: "ok", href: "/app/operations/tasks" },
  ];

  const changes = buildChanges({
    tasks: taskRows,
    receivables: invoices.map((r, i) => ({
      id: `inv-${i}`,
      label: `${fmt(decSub(r.total_amount, r.amount_settled).toFixed())} outstanding`,
      dueDate: r.due_date,
    })),
    payables: bills.map((r, i) => ({
      id: `bill-${i}`,
      label: `${fmt(decSub(r.total_amount, r.amount_settled).toFixed())} outstanding`,
      dueDate: r.due_date,
    })),
    now,
  });

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      {!embedded && (
        <PageHead
          eyebrow="Command Centre"
          title="What needs attention"
          lede="Exceptions across every department, most severe first. Everything below is a record in the system — nothing on this screen is estimated or illustrative."
          actions={
            <>
              <Link className="btn ghost sm" href="/app/portfolio">Portfolio</Link>
              <Link className="btn ghost sm" href="/app/command/health">Health</Link>
              <Link className="btn ghost sm" href="/app/command/analyze">Analyse</Link>
              <Link className="btn ghost sm" href="/app/command/cases">AI cases</Link>
              <Link className="btn ghost sm" href="/app/command/memory">Memory</Link>
            </>
          }
        />
      )}

      {/* A degraded read is stated FIRST, before any figure, because every
          number below it is then incomplete. */}
      {degraded && (
        <div style={{ marginBottom: "var(--sp-4)" }}>
          <StateNote kind="partial" title="Some data sources failed to load">
            {failedSources.join(", ")} did not return. Figures on this screen may be incomplete —
            this is a system problem, not a clean bill of health. It has been reported to monitoring.
          </StateNote>
        </div>
      )}

      {/* ── THE SIGNATURE COMPOSITION ─────────────────────────────────── */}
      <div className="centre">
        <div className="centre-summary card pad-lg">
          <ConditionInstrument segments={segments} degraded={degraded} label="Today" />
        </div>

        <div className="centre-action stack gap-2">
          <div className="card">
            <Section title="Executive brief" meta={`${briefItems.length} matters`} />
            <ExecutiveBriefing items={briefItems} />
          </div>

          <div className="card">
            <Section title="What changed" meta="last 24 hours" />
            <ChangeLedger items={changes} since="yesterday" />
          </div>
        </div>
      </div>

      {/* ── MONEY: the position, the direction, and what is committed ──── */}
      <Section title="Money" meta="cash · receivables · payables · commitments" />
      <div className="grid cols-4">
        <div className="card stat">
          <div className="k">Cash on hand</div>
          <div className="v">{fmt(cashTotal)}</div>
          <div className="d">{fmtNumber(cash.accounts.length)} account(s)</div>
        </div>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Receivables outstanding</div>
          <div className="v">{fmt(ar.total)}</div>
          <div className="d">
            {decGtZero(ar.overdue) ? (
              <Signal kind="warn">Overdue {fmt(ar.overdue)}</Signal>
            ) : (
              <Signal kind="ok">None overdue</Signal>
            )}
          </div>
        </Link>
        <Link href="/app/finance/receivables" className="card stat">
          <div className="k">Payables outstanding</div>
          <div className="v">{fmt(ap.total)}</div>
          <div className="d">
            {decGtZero(ap.overdue) ? (
              <Signal kind="critical">Overdue {fmt(ap.overdue)}</Signal>
            ) : (
              <Signal kind="ok">None overdue</Signal>
            )}
          </div>
        </Link>
        <Link href="/app/procurement/purchase-orders" className="card stat">
          <div className="k">Expected commitments</div>
          <div className="v">{fmt(commitmentTotal)}</div>
          <div className="d">
            {fmtNumber(commitmentOutflows.length)} PO(s) / commitment(s) in forecast
          </div>
        </Link>
      </div>

      <div className="grid cols-2 mt-3">
        <div className="card">
          <Section title="Cash — next 90 days" meta="the marked point is the trough" />
          <p className="small dim" style={{ marginBottom: "var(--sp-3)" }}>
            Projected from open invoices in, and bills plus committed outflows out. No revenue that
            has not been invoiced is assumed.
          </p>
          <AreaLineChart
            points={fc.points.map((p) => ({ label: p.date.slice(5), value: dec(p.balance).toNumber(), display: fmt(p.balance) }))}
          />
          {fc.goesNegative && (
            <div className="mt-2">
              <Signal kind="critical">Projection crosses below zero — see the brief above</Signal>
            </div>
          )}
        </div>
        <div className="card">
          <Section title="Receivables vs payables" meta="by age" />
          <div className="t-label" style={{ marginBottom: 4 }}>Receivables — owed to you</div>
          <BarChart data={agingBars(ar.buckets, fmt)} height={116} />
          <div className="t-label" style={{ marginTop: "var(--sp-4)", marginBottom: 4 }}>
            Payables — you owe
          </div>
          <BarChart data={agingBars(ap.buckets, fmt)} height={116} />
        </div>
      </div>

      {/* ── PRIORITY MATTERS ──────────────────────────────────────────── */}
      <div id="needs-attention">
        <Section title="Needs attention" meta={`${exceptions.length} open`} />
      </div>
      {exceptions.length === 0 ? (
        degraded ? (
          <StateNote kind="partial" title="Data degraded — no all-clear can be given">
            Exception detection is incomplete because data sources failed to load. The absence of
            listed exceptions here does not mean there are none.
          </StateNote>
        ) : tasks.length === 0 && caps.length === 0 ? (
          <StateNote kind="empty" title="No task or capacity data yet">
            Once tasks and capacity snapshots exist for this company, exceptions appear here.
          </StateNote>
        ) : (
          <StateNote kind="empty" title="Nothing needs attention right now">
            No record in the sources checked is overdue, blocked or over capacity.
          </StateNote>
        )
      ) : (
        <div className="field-matters">
          {exceptions.map((e, i) => (
            <Matter
              key={`${e.type}-${i}`}
              kind={e.type.replace(/_/g, " ")}
              kindIcon={
                e.severity === "critical"
                  ? "alert-triangle"
                  : e.severity === "warn"
                    ? "alert-circle"
                    : "info"
              }
              band={e.severity === "critical" ? "critical" : e.severity === "warn" ? "high" : "normal"}
              title={e.message}
              footer={
                <>
                  <Signal
                    kind={e.severity === "critical" ? "critical" : e.severity === "warn" ? "warn" : "info"}
                  >
                    {e.severity === "critical"
                      ? "Act now"
                      : e.severity === "warn"
                        ? "Decide today"
                        : "Watch"}
                  </Signal>
                  <Badge variant={badgeClass(e.severity)}>{e.type.replace(/_/g, " ")}</Badge>
                </>
              }
            />
          ))}
        </div>
      )}

      {/* The sentence briefing remains available to assistive technology and to
          anyone who prefers the linear form; it carries identical figures. */}
      <details className="mt-3">
        <summary className="t-label" style={{ cursor: "pointer", padding: "var(--sp-2) 0" }}>
          <Icon name="scroll-text" size={12} aria-hidden="true" /> Briefing as sentences
        </summary>
        <div className="stack gap-1 mt-2">
          {briefing.map((line, i) => (
            <div key={i} className="small muted">
              {line}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}
