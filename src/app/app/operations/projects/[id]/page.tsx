/**
 * PRJ-003 — Project detail.
 *
 * Shows project budget vs actual, a forecast curve by period, and resource
 * requirements (assigned people, planned/actual/remaining hours, blocked and
 * overdue tasks). Operations staff and admins may update the project status.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { postedJournalsWithLines, tasksWithAssignments } from "@/lib/embeds";
import { fmtMoney } from "@/lib/money";
import { computeProjectBudgetForecast } from "@/modules/project/budget-forecast";
import { computeResourceRequirements } from "@/modules/project/resource-requirements";
import { riskExposureLevel, riskNeedsReview } from "@/modules/project/risks";
import { decisionStatusLabel, type DecisionOption } from "@/modules/project/decisions";
import { compareScenarios } from "@/modules/project/scenarios";
import { updateProjectStatus, createProjectRisk, updateProjectRiskStatus, createProjectDecision, decideProjectDecision, createProjectScenario, chooseProjectScenario } from "../actions";
import { Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Facts, PageHead, Provenance, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Project — Singha Central" };

const PROJECT_STATUSES = ["active", "on_hold", "completed", "cancelled"] as const;
type BadgeVariant = "default" | "ok" | "warn" | "danger" | "info" | "accent";

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

function flattenJournalLines(entries: any[]): Parameters<typeof computeProjectBudgetForecast>[0]["journalEntries"] {
  const out: any[] = [];
  for (const e of entries) {
    const postingDate = e.posting_date;
    for (const jl of e.journal_lines ?? []) {
      out.push({
        id: jl.id,
        posting_date: postingDate,
        journal_lines: [
          {
            id: jl.id,
            account_code: jl.account_code,
            debit: String(jl.debit ?? 0),
            credit: String(jl.credit ?? 0),
            project_id: jl.project_id ?? null,
          },
        ],
      });
    }
  }
  return out;
}

function statusVariant(status: string): BadgeVariant {
  if (status === "active") return "ok";
  if (status === "on_hold") return "warn";
  if (status === "cancelled") return "danger";
  return "default";
}

export default async function ProjectDetailPage({ params }: { params: { id: string } }) {
  const p = await requireDepartment("operations");
  const db = supabaseReadClient();
  const projectId = params.id;

  const { data: project } = await db
    .from("projects")
    .select("id, name, code, status, created_at")
    .eq("id", projectId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!project) notFound();

  const [
    company,
    budgetLinesRaw,
    periods,
    journalEntriesRaw,
    tasksRaw,
    membershipsRaw,
    employeeProfilesRaw,
    profilesRaw,
    projectRisksRaw,
    projectDecisionsRaw,
    projectScenariosRaw,
  ] = await Promise.all([
    safe<any>(() => db.from("companies").select("base_currency").eq("id", p.companyId).limit(1) as any),
    safe<any>(() =>
      db
        .from("budget_lines")
        .select("id, account_code, project_id, period_id, amount, budgets!inner(id, currency)")
        .eq("company_id", p.companyId)
        .eq("project_id", projectId) as any,
    ),
    safe<any>(() =>
      db.from("accounting_periods").select("id, name, start_date, end_date").eq("company_id", p.companyId).order("start_date") as any,
    ),
    postedJournalsWithLines(db, p.companyId),
    // NOT an embed: `task_assignments` holds three foreign keys into `tasks`,
    // so `tasks(…, task_assignments(...))` is ambiguous and returns nothing,
    // which made every project report "no assigned staff". See src/lib/embeds.ts.
    tasksWithAssignments(db, p.companyId).then((rows) =>
      rows.filter((t) => t.project_id === projectId),
    ),
    safe<any>(() => db.from("memberships").select("id, user_id").eq("company_id", p.companyId) as any),
    safe<any>(() =>
      db
        .from("employee_profiles")
        .select("membership_id, contracted_weekly_hours, reserved_weekly_hours")
        .eq("company_id", p.companyId) as any,
    ),
    safe<any>(() => db.from("profiles").select("id, full_name, username").eq("company_id", p.companyId) as any),
    safe<any>(() =>
      db
        .from("project_risks")
        .select("id, title, description, owner_id, mitigation, impact, likelihood, status, review_date")
        .eq("company_id", p.companyId)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }) as any,
    ),
    safe<any>(() =>
      db
        .from("project_decisions")
        .select("id, title, context, options, decided_option_id, rationale, decided_by, decided_at, status")
        .eq("company_id", p.companyId)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }) as any,
    ),
    safe<any>(() =>
      db
        .from("project_scenarios")
        .select("id, title, assumptions, best_case_total, expected_total, worst_case_total, currency, chosen")
        .eq("company_id", p.companyId)
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }) as any,
    ),
  ]);

  const baseCurrency = (company[0]?.base_currency as string) || "LKR";
  const budgetCurrency =
    (budgetLinesRaw[0]?.budgets?.currency as string) ||
    (budgetLinesRaw[0]?.budgets?.[0]?.currency as string) ||
    baseCurrency;

  const budgetLines = budgetLinesRaw.map((bl: any) => ({
    id: bl.id,
    account_code: bl.account_code ?? null,
    project_id: bl.project_id ?? null,
    period_id: bl.period_id,
    amount: String(bl.amount ?? 0),
  }));

  const journalEntries = flattenJournalLines(journalEntriesRaw);

  const periodInputs = periods.map((pp: any) => ({
    id: pp.id,
    name: pp.name,
    start_date: pp.start_date,
    end_date: pp.end_date,
  }));

  const budgetForecast = computeProjectBudgetForecast({
    projectId,
    budgetLines,
    journalEntries,
    periods: periodInputs,
    currency: budgetCurrency,
  });

  const membershipById = new Map((membershipsRaw ?? []).map((m: any) => [m.id, m]));
  const employeeByMembership = new Map((employeeProfilesRaw ?? []).map((ep: any) => [ep.membership_id, ep]));
  const profileById = new Map((profilesRaw ?? []).map((pr: any) => [pr.id, pr]));

  const tasks = (tasksRaw ?? []).map((t: any) => ({
    id: t.id,
    project_id: projectId,
    status: t.status,
    title: t.title,
    estimate_hours: t.estimate_hours != null ? Number(t.estimate_hours) : null,
    actual_hours: t.actual_hours != null ? Number(t.actual_hours) : null,
    remaining_hours: t.remaining_hours != null ? Number(t.remaining_hours) : null,
    due_date: t.due_date,
  }));

  const assignments: any[] = [];
  for (const t of tasksRaw ?? []) {
    for (const a of t.task_assignments ?? []) {
      assignments.push({
        id: a.id,
        task_id: t.id,
        membership_id: a.membership_id ?? null,
        estimate_hours: a.estimate_hours != null ? Number(a.estimate_hours) : null,
      });
    }
  }

  const memberships = (membershipsRaw ?? []).map((m: any) => ({
    id: m.id,
    user_id: m.user_id ?? null,
  }));

  const employees = (membershipsRaw ?? []).map((m: any) => {
    const profile = m.user_id ? profileById.get(m.user_id) : undefined;
    const ep = employeeByMembership.get(m.id);
    return {
      id: m.user_id ?? m.id,
      full_name: profile?.full_name ?? null,
      username: profile?.username ?? null,
      contracted_weekly_hours: ep?.contracted_weekly_hours != null ? Number(ep.contracted_weekly_hours) : null,
      reserved_weekly_hours: ep?.reserved_weekly_hours != null ? Number(ep.reserved_weekly_hours) : null,
    };
  });

  const resourceReq = computeResourceRequirements({
    projectId,
    tasks,
    assignments,
    memberships,
    employees,
  });

  const fmt = (v: string) => fmtMoney(v, budgetCurrency);
  const periodById = new Map(periods.map((pp: any) => [pp.id, pp]));

  const projectRisks = (projectRisksRaw ?? []).map((r: any) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    ownerId: r.owner_id,
    mitigation: r.mitigation,
    impact: r.impact,
    likelihood: r.likelihood,
    status: r.status,
    reviewDate: r.review_date,
    exposure: riskExposureLevel({ impact: r.impact, likelihood: r.likelihood, status: r.status }),
    needsReview: r.status === "open" && riskNeedsReview(r.review_date),
  }));

  const projectDecisions = (projectDecisionsRaw ?? []).map((d: any) => ({
    id: d.id,
    title: d.title,
    context: d.context,
    options: Array.isArray(d.options) ? (d.options as DecisionOption[]) : [],
    decidedOptionId: d.decided_option_id,
    rationale: d.rationale,
    decidedBy: d.decided_by,
    decidedAt: d.decided_at,
    status: d.status,
    statusLabel: decisionStatusLabel(d.status, d.decided_option_id),
  }));

  const projectScenarios = (projectScenariosRaw ?? []).map((s: any) => ({
    id: s.id,
    title: s.title,
    assumptions: s.assumptions,
    bestCaseTotal: String(s.best_case_total ?? 0),
    expectedTotal: String(s.expected_total ?? 0),
    worstCaseTotal: String(s.worst_case_total ?? 0),
    currency: s.currency,
    chosen: s.chosen,
  }));
  const scenarioComparison = compareScenarios(projectScenarios);

  const forecastColumns: DataTableColumn<typeof budgetForecast.forecastCurve[number]>[] = [
    {
      key: "period",
      header: "Period",
      render: (point) => (
        <span className="dim small">
          {point.periodName ?? point.periodId}
          <span className="dim"> · {fmtDate(point.startDate)} → {fmtDate(point.endDate)}</span>
        </span>
      ),
    },
    { key: "budgeted", header: "Budgeted", align: "right", render: (point) => fmt(point.budgeted) },
    { key: "actual", header: "Actual", align: "right", render: (point) => fmt(point.actual) },
    {
      key: "variance",
      header: "Variance",
      align: "right",
      // variance = actual − budgeted, so a POSITIVE variance is overspend and a
      // negative one is underspend. Colouring the minus sign red said the
      // opposite, and contradicted the totals directly above this table.
      render: (point) => {
        const value = Number(point.variance);
        const over = Number.isFinite(value) && value > 0;
        return (
          <span style={{ color: over ? "var(--danger)" : "var(--ok)" }}>{fmt(point.variance)}</span>
        );
      },
    },
  ];

  const resourceColumns: DataTableColumn<typeof resourceReq.people[number]>[] = [
    { key: "person", header: "Person", render: (person) => person.name },
    { key: "planned", header: "Planned h", align: "right", render: (person) => fmtNumber(person.plannedHours) },
    { key: "actual", header: "Actual h", align: "right", render: (person) => fmtNumber(person.actualHours) },
    { key: "remaining", header: "Remaining h", align: "right", render: (person) => fmtNumber(person.remainingHours) },
    { key: "open", header: "Open", align: "right", render: (person) => fmtNumber(person.openTasks) },
    {
      key: "blocked",
      header: "Blocked",
      align: "right",
      render: (person) => <span style={{ color: person.blockedTasks > 0 ? "var(--danger)" : undefined }}>{fmtNumber(person.blockedTasks)}</span>,
    },
    {
      key: "overdue",
      header: "Overdue",
      align: "right",
      render: (person) => <span style={{ color: person.overdueTasks > 0 ? "var(--danger)" : undefined }}>{fmtNumber(person.overdueTasks)}</span>,
    },
    {
      key: "status",
      header: "Status",
      render: (person) => <Badge variant={person.status === "overloaded" ? "danger" : person.status === "underallocated" ? "warn" : "ok"}>{person.status}</Badge>,
    },
  ];

  const riskColumns: DataTableColumn<typeof projectRisks[number]>[] = [
    { key: "title", header: "Title", render: (r) => r.title },
    {
      key: "impact",
      header: "Impact",
      render: (r) => <Badge variant={r.impact === "critical" || r.impact === "high" ? "danger" : r.impact === "medium" ? "warn" : "default"}>{r.impact}</Badge>,
    },
    { key: "likelihood", header: "Likelihood", render: (r) => r.likelihood },
    {
      key: "exposure",
      header: "Exposure",
      render: (r) => <Badge variant={r.exposure === "severe" ? "danger" : r.exposure === "high" ? "warn" : "default"}>{r.exposure}</Badge>,
    },
    { key: "status", header: "Status", render: (r) => r.status },
    {
      key: "review",
      header: "Review",
      render: (r) => r.needsReview ? <Badge variant="danger">due</Badge> : r.reviewDate ? fmtDate(r.reviewDate) : "—",
    },
    {
      key: "action",
      header: "Action",
      render: (r) => (
        <form action={updateProjectRiskStatus} className="row gap-1">
          <input type="hidden" name="risk_id" value={r.id} />
          <select name="status" className="input sm" defaultValue={r.status}>
            <option value="open">open</option>
            <option value="mitigated">mitigated</option>
            <option value="accepted">accepted</option>
            <option value="closed">closed</option>
          </select>
          <button className="btn sm" type="submit">Save</button>
        </form>
      ),
    },
  ];

  const scenarioColumns: DataTableColumn<typeof projectScenarios[number]>[] = [
    {
      key: "title",
      header: "Scenario",
      render: (s) => (
        <>
          {s.title} {s.id === scenarioComparison.preferredId && <Badge variant="ok">advisory preferred</Badge>}
        </>
      ),
    },
    { key: "best", header: "Best", align: "right", render: (s) => fmtMoney(s.bestCaseTotal, s.currency) },
    { key: "expected", header: "Expected", align: "right", render: (s) => fmtMoney(s.expectedTotal, s.currency) },
    { key: "worst", header: "Worst", align: "right", render: (s) => fmtMoney(s.worstCaseTotal, s.currency) },
    { key: "chosen", header: "Chosen", render: (s) => (s.chosen ? "✓" : "—") },
    {
      key: "action",
      header: "Action",
      render: (s) =>
        !s.chosen ? (
          <form action={chooseProjectScenario}>
            <input type="hidden" name="scenario_id" value={s.id} />
            <button className="btn sm" type="submit">Choose</button>
          </form>
        ) : null,
    },
  ];

  // The project's condition, derived from the records already read above. No
  // health score and no percentage-complete is invented: a project is at risk
  // when work on it is stuck or a risk is open, and over budget when the
  // variance the budget engine computed is negative.
  // The budget engine computes `variance = actual − budgeted`, so a POSITIVE
  // variance means more was spent than budgeted. Treating a leading minus sign
  // as "over budget" reported every under-spent project as overspending.
  const varianceValue = Number(budgetForecast.budgetVsActual.totals.variance);
  const overBudget = Number.isFinite(varianceValue) && varianceValue > 0;
  const stuck = resourceReq.totals.blockedTasks + resourceReq.totals.overdueTasks;
  const openRiskCount = projectRisks.filter((r: any) => r.status === "open").length;

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow={project.code ? `Project ${project.code}` : "Project"}
        title={project.name}
        lede="Objective, money, people, risk and the decisions taken — everything recorded against this project, in one room."
        actions={
          <Link className="btn ghost sm" href="/app/operations/projects">
            <Icon name="chevron-left" size={14} /> Projects
          </Link>
        }
      />

      {/* ── CONDITION ───────────────────────────────────────────────────── */}
      <div className="card">
        <div className="row wrap gap-3 between">
          <Badge variant={statusVariant(project.status)}>{project.status.replace(/_/g, " ")}</Badge>
          {stuck > 0 ? (
            <Signal kind="critical">
              {fmtNumber(stuck)} task{stuck === 1 ? "" : "s"} blocked or overdue
            </Signal>
          ) : (
            <Signal kind="ok">No blocked or overdue work</Signal>
          )}
          {openRiskCount > 0 ? (
            <Signal kind="warn">
              {fmtNumber(openRiskCount)} open risk{openRiskCount === 1 ? "" : "s"}
            </Signal>
          ) : (
            <Signal kind="ok">No open risks recorded</Signal>
          )}
          {budgetForecast.budgetVsActual.totals.budgeted === "0.00" ? (
            <Signal kind="offline">No budget recorded to compare against</Signal>
          ) : overBudget ? (
            <Signal kind="critical">Over budget</Signal>
          ) : (
            <Signal kind="ok">Within budget</Signal>
          )}
        </div>
      </div>

      <div className="split">
        <div className="stack" style={{ gap: "var(--sp-2)", minWidth: 0 }}>
          {/* ── MONEY ───────────────────────────────────────────────────── */}
          <Section title="Budget against actual" meta={budgetCurrency} />
          <div className="grid cols-4">
            <div className="card stat">
              <div className="k">Budgeted</div>
              <div className="v">{fmt(budgetForecast.budgetVsActual.totals.budgeted)}</div>
            </div>
            <div className="card stat">
              <div className="k">Actual</div>
              <div className="v">{fmt(budgetForecast.budgetVsActual.totals.actual)}</div>
            </div>
            <div className="card stat">
              <div className="k">Variance</div>
              <div className="v" style={{ color: overBudget ? "var(--danger)" : "var(--ok)" }}>
                {fmt(budgetForecast.budgetVsActual.totals.variance)}
              </div>
            </div>
            <div className="card stat">
              <div className="k">Variance %</div>
              <div className="v">
                {budgetForecast.budgetVsActual.totals.variancePercent ?? "—"}
                {budgetForecast.budgetVsActual.totals.variancePercent != null ? "%" : ""}
              </div>
              <div className="d">
                {budgetForecast.budgetVsActual.totals.variancePercent == null
                  ? "No budget recorded to compare against"
                  : ""}
              </div>
            </div>
          </div>

          <Section title="Forecast curve by period" />
          <div className="card">
            <DataTable
              columns={forecastColumns}
              rows={budgetForecast.forecastCurve}
              keyExtractor={(point) => point.periodId}
              emptyTitle="No periods defined"
              emptyDescription="Define accounting periods to see the curve."
            />
          </div>

          {/* ── PEOPLE ──────────────────────────────────────────────────── */}
          <Section title="Resource requirements" meta="from assigned, estimated tasks" />
          <div className="grid cols-4">
            <div className="card stat">
              <div className="k">Assigned people</div>
              <div className="v">{fmtNumber(resourceReq.totals.assignedPeople)}</div>
            </div>
            <div className="card stat">
              <div className="k">Planned hours</div>
              <div className="v">{fmtNumber(resourceReq.totals.plannedHours)}</div>
            </div>
            <div className="card stat">
              <div className="k">Actual hours</div>
              <div className="v">{fmtNumber(resourceReq.totals.actualHours)}</div>
            </div>
            <div className="card stat">
              <div className="k">Remaining hours</div>
              <div className="v">{fmtNumber(resourceReq.totals.remainingHours)}</div>
            </div>
          </div>
          <div className="card mt-2">
            <div className="row wrap gap-4" style={{ marginBottom: "var(--sp-3)" }}>
              <Signal kind="info">{fmtNumber(resourceReq.totals.openTasks)} open</Signal>
              <Signal kind={resourceReq.totals.blockedTasks > 0 ? "blocked" : "ok"}>
                {fmtNumber(resourceReq.totals.blockedTasks)} blocked
              </Signal>
              <Signal kind={resourceReq.totals.overdueTasks > 0 ? "critical" : "ok"}>
                {fmtNumber(resourceReq.totals.overdueTasks)} overdue
              </Signal>
            </div>
            <DataTable
              columns={resourceColumns}
              rows={resourceReq.people}
              keyExtractor={(person) => person.membershipId}
              emptyTitle="No assigned staff"
              emptyDescription="Assign tasks with estimates to see the load per person."
            />
            {resourceReq.unassigned.taskCount > 0 && (
              <div className="mt-3">
                <StateNote kind="partial" title="Work with nobody accountable">
                  {fmtNumber(resourceReq.unassigned.taskCount)} task(s),{" "}
                  {fmtNumber(resourceReq.unassigned.plannedHours)}h planned and{" "}
                  {fmtNumber(resourceReq.unassigned.remainingHours)}h remaining are not assigned to
                  anyone, so they appear in no person&apos;s load.
                </StateNote>
              </div>
            )}
          </div>
        </div>

        {/* ── CONTEXT LAYER ─────────────────────────────────────────────── */}
        <aside className="split-aside">
          <div className="card">
            <Section title="Lifecycle" />
            <form action={updateProjectStatus} className="stack gap-2">
              <input type="hidden" name="project_id" value={projectId} />
              <label className="field">
                <span className="label">Project state</span>
                <select name="status" className="select" defaultValue={project.status}>
                  {PROJECT_STATUSES.map((s) => (
                    <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
                  ))}
                </select>
              </label>
              <button className="btn" type="submit">Save state</button>
            </form>
          </div>

          <div className="card mt-2">
            <Section title="At a glance" />
            <Facts
              items={[
                { k: "Code", v: project.code ?? "", missing: !project.code },
                { k: "State", v: project.status.replace(/_/g, " ") },
                { k: "Currency", v: budgetCurrency },
                { k: "Open tasks", v: fmtNumber(resourceReq.totals.openTasks), numeric: true },
                { k: "Open risks", v: fmtNumber(openRiskCount), numeric: true },
                { k: "Decisions recorded", v: fmtNumber(projectDecisions.length), numeric: true },
                { k: "Scenarios", v: fmtNumber(projectScenarios.length), numeric: true },
              ]}
            />
          </div>
        </aside>
      </div>

      {/* ── RISK ────────────────────────────────────────────────────────── */}
      <Section title="Project risks" meta={`${openRiskCount} open of ${projectRisks.length} recorded`} />
      <div className="card">
        <DataTable
          columns={riskColumns}
          rows={projectRisks}
          keyExtractor={(r) => r.id}
          emptyTitle="No risks recorded"
          emptyDescription="A project with no recorded risks is not the same as a project with no risks."
        />

        <div className="mt-3">
          <details>
            <summary className="t-label" style={{ cursor: "pointer", padding: "var(--sp-2) 0" }}>
              <Icon name="plus" size={12} aria-hidden="true" /> Record a risk
            </summary>
          <form action={createProjectRisk} className="stack gap-1 mt-2">
            <input type="hidden" name="project_id" value={projectId} />
            <div className="row gap-1 wrap">
              <input name="title" className="input" placeholder="Risk title" required style={{ minWidth: 200 }} />
              <select name="impact" className="input" defaultValue="medium">
                <option value="low">low impact</option>
                <option value="medium">medium impact</option>
                <option value="high">high impact</option>
                <option value="critical">critical impact</option>
              </select>
              <select name="likelihood" className="input" defaultValue="medium">
                <option value="low">low likelihood</option>
                <option value="medium">medium likelihood</option>
                <option value="high">high likelihood</option>
                <option value="critical">critical likelihood</option>
              </select>
              <select name="status" className="input" defaultValue="open">
                <option value="open">open</option>
                <option value="mitigated">mitigated</option>
                <option value="accepted">accepted</option>
                <option value="closed">closed</option>
              </select>
              <input name="review_date" type="date" className="input" />
            </div>
            <textarea name="description" className="input" placeholder="Description" rows={2} />
            <textarea name="mitigation" className="input" placeholder="Mitigation" rows={2} />
            <button className="btn" type="submit">Add risk</button>
          </form>
          </details>
        </div>
      </div>

      {/* ── DECISIONS ───────────────────────────────────────────────────── */}
      <Section title="Project decisions" meta={`${projectDecisions.length} recorded`} />
      <div className="card">
        {projectDecisions.length === 0 ? (
          <EmptyState
            title="No decisions recorded"
            description="A decision recorded here carries its options, the one chosen and the reason — so a future reader can see not only what was done but what was rejected."
            icon="git-branch"
          />
        ) : (
          <div className="stack gap-3">
            {projectDecisions.map((d) => (
              <Provenance
                key={d.id}
                kind={d.status === "decided" ? "human" : d.status === "reversed" ? "done" : "system"}
                label={d.status === "decided" ? "Human decision" : d.statusLabel}
              >
                <div className="row between wrap gap-2">
                  <strong>{d.title}</strong>
                  <Badge variant={d.status === "decided" ? "ok" : d.status === "reversed" ? "warn" : "default"}>{d.statusLabel}</Badge>
                </div>
                {d.context && <p className="small muted mt-1">{d.context}</p>}
                {d.options.length > 0 && (
                  <ul className="small mt-2" style={{ paddingLeft: "var(--sp-4)" }}>
                    {d.options.map((o) => (
                      <li
                        key={o.id}
                        style={
                          o.id === d.decidedOptionId
                            ? { fontWeight: 700, color: "var(--text)" }
                            : { color: "var(--text-dim)" }
                        }
                      >
                        {o.label}
                        {o.id === d.decidedOptionId && " — chosen"}
                      </li>
                    ))}
                  </ul>
                )}
                {d.rationale && <p className="small mt-2">Rationale: {d.rationale}</p>}
                {d.status !== "decided" && d.status !== "reversed" && (
                  <form action={decideProjectDecision} className="stack gap-1 mt-3">
                    <input type="hidden" name="decision_id" value={d.id} />
                    <input type="hidden" name="status" value="decided" />
                    <select name="option_id" className="select" required>
                      <option value="">Choose option…</option>
                      {d.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <textarea name="rationale" className="textarea" placeholder="Why this option, and what was given up" rows={2} />
                    <button className="btn sm" type="submit">Record decision</button>
                  </form>
                )}
              </Provenance>
            ))}
          </div>
        )}

        <div className="mt-3">
          <details>
            <summary className="t-label" style={{ cursor: "pointer", padding: "var(--sp-2) 0" }}>
              <Icon name="plus" size={12} aria-hidden="true" /> Record a decision
            </summary>
          <form action={createProjectDecision} className="stack gap-1 mt-2">
            <input type="hidden" name="project_id" value={projectId} />
            <input name="title" className="input" placeholder="Decision title" required />
            <textarea name="context" className="input" placeholder="Context" rows={2} />
            <textarea
              name="options"
              className="input"
              placeholder='Options as JSON, e.g. [{"id":"a","label":"Option A"},{"id":"b","label":"Option B"}]'
              rows={2}
              defaultValue='[{"id":"a","label":"Option A"},{"id":"b","label":"Option B"}]'
            />
            <button className="btn" type="submit">Add decision</button>
          </form>
          </details>
        </div>
      </div>

      {/* ── SCENARIOS ───────────────────────────────────────────────────── */}
      <Section title="Scenario comparison" meta="compare outcomes before committing" />
      <div className="card">
        <DataTable
          columns={scenarioColumns}
          rows={projectScenarios}
          keyExtractor={(s) => s.id}
          emptyTitle="No scenarios recorded"
          emptyDescription="Record best, expected and worst cases to compare options side by side."
        />
        {scenarioComparison.preferredId && (
          <div className="mt-3">
            <Provenance kind="ai" label="Advisory preference">
              <p className="small muted">
                <strong>
                  {projectScenarios.find((s) => s.id === scenarioComparison.preferredId)?.title}
                </strong>{" "}
                — {scenarioComparison.reason}. This is a comparison of the figures recorded against
                each scenario; choosing one is a human decision and is recorded as such.
              </p>
            </Provenance>
          </div>
        )}

        <div className="mt-3">
          <details>
            <summary className="t-label" style={{ cursor: "pointer", padding: "var(--sp-2) 0" }}>
              <Icon name="plus" size={12} aria-hidden="true" /> Record a scenario
            </summary>
          <form action={createProjectScenario} className="stack gap-1 mt-2">
            <input type="hidden" name="project_id" value={projectId} />
            <div className="row gap-1 wrap">
              <input name="title" className="input" placeholder="Scenario title" required style={{ minWidth: 200 }} />
              <input name="currency" className="input" placeholder="Currency" defaultValue={budgetCurrency} style={{ width: 80 }} />
            </div>
            <div className="row gap-1 wrap">
              <input name="best_case_total" className="input" placeholder="Best case total" defaultValue="0" />
              <input name="expected_total" className="input" placeholder="Expected total" defaultValue="0" />
              <input name="worst_case_total" className="input" placeholder="Worst case total" defaultValue="0" />
            </div>
            <button className="btn" type="submit">Add scenario</button>
          </form>
          </details>
        </div>
      </div>
    </div>
  );
}
