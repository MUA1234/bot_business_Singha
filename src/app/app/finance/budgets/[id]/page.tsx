/**
 * FIN-006 — Budget detail. Shows budget lines vs actual journal activity and a
 * scenario-adjusted projection (best/expected/worst). Company-scoped.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { fmtMoney } from "@/lib/money";
import { fmtNumber } from "@/lib/format";
import { computeBudgetVsActual } from "@/modules/finance/budget-vs-actual";
import { projectScenarios, type ScenarioKind } from "@/modules/finance/scenario-analysis";
import {
  Card,
  CardHeader,
  CardBody,
  EmptyState,
  DataTable,
  type DataTableColumn,
  Button,
} from "@/components/ui";
import { createBudgetLine, createScenario } from "../actions";

export const metadata = { title: "Budget Detail — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

function flattenJournalLines(entries: any[]): { id: string; account_code: string; debit: string; credit: string; project_id: string | null; posting_date: string }[] {
  const out: ReturnType<typeof flattenJournalLines> = [];
  for (const e of entries) {
    const postingDate = e.posting_date;
    for (const jl of e.journal_lines ?? []) {
      out.push({
        id: jl.id,
        account_code: jl.account_code,
        debit: String(jl.debit ?? 0),
        credit: String(jl.credit ?? 0),
        project_id: jl.project_id ?? null,
        posting_date: postingDate,
      });
    }
  }
  return out;
}

function scenarioFromAssumptions(assumptions: Record<string, unknown>): { byAccount: Record<string, { percent?: string; amount?: string }>; kindMultiplier: Record<ScenarioKind, string> } {
  const byAccount: Record<string, { percent?: string; amount?: string }> = {};
  const kindMultiplier: Partial<Record<ScenarioKind, string>> = {};

  for (const [key, value] of Object.entries(assumptions)) {
    if (key === "kindMultiplier" && value && typeof value === "object") {
      for (const k of ["best", "expected", "worst"] as ScenarioKind[]) {
        const v = (value as Record<string, unknown>)[k];
        if (typeof v === "string" || typeof v === "number") kindMultiplier[k] = String(v);
      }
      continue;
    }
    if (value && typeof value === "object") {
      const obj = value as Record<string, unknown>;
      const entry: { percent?: string; amount?: string } = {};
      if (typeof obj.percent === "string" || typeof obj.percent === "number") entry.percent = String(obj.percent);
      if (typeof obj.amount === "string" || typeof obj.amount === "number") entry.amount = String(obj.amount);
      byAccount[key] = entry;
    }
  }

  return { byAccount, kindMultiplier: kindMultiplier as Record<ScenarioKind, string> };
}

export default async function BudgetDetailPage({ params, searchParams }: { params: { id: string }; searchParams?: { scenario?: string } }) {
  const p = await requireDepartment("finance");
  const db = supabaseReadClient();
  const budgetId = params.id;

  const { data: budget } = await db
    .from("budgets")
    .select("id, name, fiscal_year_id, currency")
    .eq("id", budgetId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!budget) notFound();

  const [budgetLinesRaw, periods, projects, accounts, journalEntriesRaw, scenariosRaw] = await Promise.all([
    safe<any>(() => db.from("budget_lines").select("id, account_code, project_id, period_id, amount").eq("budget_id", budgetId) as any),
    safe<any>(() => db.from("accounting_periods").select("id, name, start_date, end_date").eq("company_id", p.companyId).order("start_date") as any),
    safe<any>(() => db.from("projects").select("id, name").eq("company_id", p.companyId).order("name") as any),
    safe<any>(() => db.from("chart_of_accounts").select("code, name").eq("company_id", p.companyId).eq("is_active", true).order("code") as any),
    safe<any>(() =>
      db
        .from("journal_entries")
        .select("id, posting_date, journal_lines(id, account_code, debit, credit, project_id)")
        .eq("company_id", p.companyId)
        .eq("status", "posted") as any,
    ),
    safe<any>(() =>
      db
        .from("forecast_scenarios")
        .select("id, kind, assumptions, forecasts!inner(id, name)")
        .eq("company_id", p.companyId)
        .eq("forecasts.name", `Budget scenario: ${budgetId}`) as any,
    ),
  ]);

  const currency = budget.currency as string;
  const fmt = (v: string) => fmtMoney(v, currency);

  const journalLines = flattenJournalLines(journalEntriesRaw);

  const budgetLines = budgetLinesRaw.map((bl: any) => ({
    id: bl.id,
    account_code: bl.account_code ?? null,
    project_id: bl.project_id ?? null,
    period_id: bl.period_id,
    amount: String(bl.amount ?? 0),
  }));

  const periodInputs = periods.map((pp: any) => ({ id: pp.id, start_date: pp.start_date, end_date: pp.end_date }));
  const bva = computeBudgetVsActual({ budgetLines, journalLines, periods: periodInputs, currency });

  const periodById = new Map(periods.map((pp: any) => [pp.id, pp]));
  const projectById = new Map(projects.map((pr: any) => [pr.id, pr.name]));

  const selectedScenario = (["best", "expected", "worst"] as ScenarioKind[]).includes(searchParams?.scenario as ScenarioKind)
    ? (searchParams!.scenario as ScenarioKind)
    : ("expected" as ScenarioKind);

  // Build assumptions from the most recent scenario of each kind, preferring the selected kind.
  const latestByKind = new Map<ScenarioKind, any>();
  for (const s of scenariosRaw) {
    const kind = s.kind as ScenarioKind;
    if (!latestByKind.has(kind)) latestByKind.set(kind, s);
  }
  const assumptionsSource = latestByKind.get(selectedScenario)?.assumptions ?? {};
  const assumptions = scenarioFromAssumptions(assumptionsSource as Record<string, unknown>);
  const scenarioResult = projectScenarios({ budgetLines, journalLines, periods: periodInputs, assumptions, currency });

  const scenarioLineById = new Map(scenarioResult.lines.map((l) => [l.budgetLineId, l]));

  const lineColumns: DataTableColumn<any>[] = [
    { key: "period", header: "Period", render: (l) => <span className="dim small">{periodById.get(l.periodId)?.name ?? l.periodId}</span> },
    { key: "account", header: "Account", className: "mono", render: (l) => l.accountCode ?? "—" },
    { key: "project", header: "Project", render: (l) => <span className="dim">{l.projectId ? projectById.get(l.projectId) ?? l.projectId : "—"}</span> },
    { key: "budgeted", header: "Budgeted", align: "right", render: (l) => fmt(l.budgeted) },
    { key: "actual", header: "Actual", align: "right", render: (l) => fmt(l.actual) },
    {
      key: "variance",
      header: "Variance",
      align: "right",
      render: (l) => (
        <span style={{ color: l.variance.startsWith("-") ? "var(--danger)" : "var(--ok)" }}>
          {fmt(l.variance)}
        </span>
      ),
    },
    {
      key: "variancePct",
      header: "Variance %",
      align: "right",
      render: (l) => (l.variancePercent != null ? `${fmtNumber(l.variancePercent, 1)}%` : "—"),
    },
    {
      key: "projected",
      header: `Projected (${selectedScenario})`,
      align: "right",
      render: (l) => {
        const scenarioLine = scenarioLineById.get(l.budgetLineId);
        return scenarioLine ? fmt(scenarioLine.projected[selectedScenario]) : "—";
      },
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{budget.name}</h1>
          <p className="muted mt-1">Budget vs actual — {currency}</p>
        </div>
        <Link className="btn ghost sm" href="/app/finance/budgets">← Budgets</Link>
      </div>

      <div className="grid cols-4">
        <Card className="stat"><div className="k">Budgeted</div><div className="v" style={{ fontSize: "1.4rem" }}>{fmt(bva.totals.budgeted)}</div></Card>
        <Card className="stat"><div className="k">Actual</div><div className="v" style={{ fontSize: "1.4rem" }}>{fmt(bva.totals.actual)}</div></Card>
        <Card className="stat"><div className="k">Variance</div><div className="v" style={{ fontSize: "1.4rem", color: bva.totals.variance.startsWith("-") ? "var(--danger)" : "var(--ok)" }}>{fmt(bva.totals.variance)}</div></Card>
        <Card className="stat"><div className="k">Variance %</div><div className="v" style={{ fontSize: "1.4rem" }}>{bva.totals.variancePercent != null ? `${fmtNumber(bva.totals.variancePercent, 1)}%` : "—"}</div></Card>
      </div>

      <Card>
        <CardHeader title="Scenario analysis" />
        <CardBody>
          <div className="row gap-1 wrap">
            {(["best", "expected", "worst"] as ScenarioKind[]).map((kind) => (
              <Link
                key={kind}
                href={`/app/finance/budgets/${budgetId}?scenario=${kind}`}
                className={`btn sm ${selectedScenario === kind ? "" : "ghost"}`}
              >
                {kind.charAt(0).toUpperCase() + kind.slice(1)}
              </Link>
            ))}
          </div>
          <div className="grid cols-4 mt-3">
            <Card className="stat"><div className="k">Projected ({selectedScenario})</div><div className="v">{fmt(scenarioResult.totals.projected[selectedScenario])}</div></Card>
            <Card className="stat"><div className="k">vs Budget</div><div className="v">{fmt(scenarioResult.totals.vsBudget[selectedScenario])}</div></Card>
            <Card className="stat"><div className="k">vs Actual</div><div className="v">{fmt(scenarioResult.totals.vsActual[selectedScenario])}</div></Card>
            <Card className="stat"><div className="k">Actual</div><div className="v">{fmt(scenarioResult.totals.actual)}</div></Card>
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Budget lines" />
        <CardBody>
          {bva.lines.length === 0 ? (
            <EmptyState title="No budget lines yet" />
          ) : (
            <DataTable
              columns={lineColumns}
              rows={bva.lines}
              keyExtractor={(l) => l.budgetLineId}
              className="mt-3"
            />
          )}
        </CardBody>
      </Card>

      <div className="grid cols-2">
        <Card>
          <CardHeader title="Add budget line" />
          <CardBody>
            <form action={createBudgetLine} className="stack gap-1">
              <input type="hidden" name="budget_id" value={budgetId} />
              <select name="account_code" className="input">
                <option value="">Account…</option>
                {accounts.map((a: any) => (
                  <option key={a.code} value={a.code}>{a.code} — {a.name}</option>
                ))}
              </select>
              <select name="period_id" className="input" required>
                <option value="">Period…</option>
                {periods.map((pp: any) => (
                  <option key={pp.id} value={pp.id}>{pp.name}</option>
                ))}
              </select>
              <select name="project_id" className="input">
                <option value="">Project…</option>
                {projects.map((pr: any) => (
                  <option key={pr.id} value={pr.id}>{pr.name}</option>
                ))}
              </select>
              <input name="amount" className="input" placeholder={`Amount (${currency})`} inputMode="decimal" required />
              <Button type="submit">Add line</Button>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Create scenario" />
          <CardBody>
            <form action={createScenario} className="stack gap-1">
              <input type="hidden" name="budget_id" value={budgetId} />
              <select name="kind" className="input" required>
                <option value="">Kind…</option>
                <option value="best">Best</option>
                <option value="expected">Expected</option>
                <option value="worst">Worst</option>
              </select>
              <textarea name="assumptions" className="input" rows={4} placeholder='{"REV-001": {"percent": "0.10"}, "kindMultiplier": {"best": "1.10", "expected": "1.00", "worst": "0.90"}}' defaultValue='{"kindMultiplier": {"best": "1.10", "expected": "1.00", "worst": "0.90"}}' />
              <Button type="submit">Save scenario</Button>
            </form>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
