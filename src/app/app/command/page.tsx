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
import { supabaseAdmin } from "@/lib/supabase/server";
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
import { projectCash, type CashFlowItem } from "@/management/ai-manager/forecast";
import { buildBriefing } from "@/management/ai-manager/briefing";

export const metadata = { title: "Command Centre — Singha" };

/** Query that never throws: a missing table (pre-migration) yields []. */
async function safeSelect<T>(run: () => Promise<{ data: T[] | null; error: unknown }>): Promise<T[]> {
  try {
    const { data } = await run();
    return data ?? [];
  } catch {
    return [];
  }
}

export default async function CommandCentrePage() {
  const admin = await requireAdmin();
  const db = supabaseAdmin();
  const now = new Date();

  const taskRows = await safeSelect<any>(() =>
    db
      .from("tasks")
      .select("id, title, status, due_date, estimate_hours, updated_at")
      .eq("company_id", admin.companyId)
      .limit(500) as any,
  );

  const capRows = await safeSelect<any>(() =>
    db
      .from("capacity_snapshots")
      .select("membership_id, status, utilization_pct, week_start")
      .eq("company_id", admin.companyId)
      .order("week_start", { ascending: false })
      .limit(200) as any,
  );

  const invoices = await safeSelect<any>(() =>
    db
      .from("customer_invoices")
      .select("currency, total_amount, amount_settled, due_date, status")
      .eq("company_id", admin.companyId)
      .not("status", "in", "(paid,cancelled)") as any,
  );
  const bills = await safeSelect<any>(() =>
    db
      .from("supplier_bills")
      .select("currency, total_amount, amount_settled, due_date, status")
      .eq("company_id", admin.companyId)
      .not("status", "in", "(paid,cancelled)") as any,
  );

  const currency = invoices[0]?.currency ?? bills[0]?.currency ?? "LKR";
  const toItems = (rows: any[]): AgingItem[] =>
    rows.map((r) => ({
      dueDate: r.due_date ?? null,
      outstanding: String(Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0)),
    }));
  const ar = ageItems(toItems(invoices), currency, now);
  const ap = ageItems(toItems(bills), currency, now);
  const fmt = (v: string) => `${currency} ${Number(v).toLocaleString()}`;

  // Cash position: bank + cash accounts, adjusted by non-void payments.
  const [banks, cashes, pmts] = await Promise.all([
    safeSelect<any>(() => db.from("bank_accounts").select("id, name, currency, opening_balance").eq("company_id", admin.companyId) as any),
    safeSelect<any>(() => db.from("cash_accounts").select("id, name, currency, opening_balance").eq("company_id", admin.companyId) as any),
    safeSelect<any>(() => db.from("payments").select("direction, amount, bank_account_id, cash_account_id, status").eq("company_id", admin.companyId).neq("status", "void") as any),
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
  if (Number(ar.overdue) > 0)
    financeExceptions.push({ type: "overdue", severity: "critical", message: `Overdue receivables: ${fmt(ar.overdue)}` });
  if (Number(ap.overdue) > 0)
    financeExceptions.push({ type: "overdue", severity: "warn", message: `Overdue payables: ${fmt(ap.overdue)}` });

  const exceptions: Exception[] = sortBySeverity([
    ...financeExceptions,
    ...detectTaskExceptions(tasks, now),
    ...detectCapacityExceptions(caps),
  ]);
  const count = (s: Exception["severity"]) => exceptions.filter((e) => e.severity === s).length;
  const badgeClass = (s: Exception["severity"]) => (s === "critical" ? "danger" : s === "warn" ? "warn" : "info");

  // 90-day cash forecast from open invoices (in) and bills (out), for the briefing.
  const t = () => now.toISOString().slice(0, 10);
  const fc = projectCash({
    currency,
    openingCash: cashTotal,
    inflows: invoices.map((r): CashFlowItem => ({ date: r.due_date ?? t(), amount: String(Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0)) })).filter((i) => Number(i.amount) > 0),
    outflows: bills.map((r): CashFlowItem => ({ date: r.due_date ?? t(), amount: String(Number(r.total_amount ?? 0) - Number(r.amount_settled ?? 0)) })).filter((o) => Number(o.amount) > 0),
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
      <div>
        <h1>Command Centre</h1>
        <p className="muted mt-1">What needs attention now — ranked most urgent first.</p>
      </div>

      <div className="card">
        <div className="card-title">Today's briefing</div>
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
      </div>

      <div className="card">
        <div className="card-title">Needs attention</div>
        {exceptions.length === 0 ? (
          <div className="empty">
            {tasks.length === 0 && caps.length === 0
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
