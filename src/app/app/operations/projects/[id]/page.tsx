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
import { fmtMoney } from "@/lib/money";
import { computeProjectBudgetForecast } from "@/modules/project/budget-forecast";
import { computeResourceRequirements } from "@/modules/project/resource-requirements";
import { riskExposureLevel, riskNeedsReview } from "@/modules/project/risks";
import { decisionStatusLabel, type DecisionOption } from "@/modules/project/decisions";
import { compareScenarios } from "@/modules/project/scenarios";
import { updateProjectStatus, createProjectRisk, updateProjectRiskStatus, createProjectDecision, decideProjectDecision, createProjectScenario, chooseProjectScenario } from "../actions";

export const metadata = { title: "Project — Singha Central" };

const PROJECT_STATUSES = ["active", "on_hold", "completed", "cancelled"] as const;

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

function statusTone(status: string): string {
  if (status === "active") return "ok";
  if (status === "on_hold") return "warn";
  if (status === "completed") return "";
  if (status === "cancelled") return "danger";
  return "";
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
    safe<any>(() =>
      db
        .from("journal_entries")
        .select("id, posting_date, journal_lines(id, account_code, debit, credit, project_id)")
        .eq("company_id", p.companyId)
        .eq("status", "posted") as any,
    ),
    safe<any>(() =>
      db
        .from("tasks")
        .select(
          "id, title, status, estimate_hours, actual_hours, remaining_hours, due_date, task_assignments(id, membership_id, estimate_hours)")
        .eq("company_id", p.companyId)
        .eq("project_id", projectId) as any,
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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{project.name}</h1>
          <p className="muted mt-1">
            <span className={`badge ${statusTone(project.status)}`}>{project.status.replace(/_/g, " ")}</span>
            {project.code && <span className="dim small mono" style={{ marginLeft: 8 }}>{project.code}</span>}
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/operations/projects">← Projects</Link>
      </div>

      <div className="card">
        <div className="card-title">Update status</div>
        <form action={updateProjectStatus} className="row gap-1 wrap mt-2">
          <input type="hidden" name="project_id" value={projectId} />
          <select name="status" className="input" defaultValue={project.status} style={{ width: 160 }}>
            {PROJECT_STATUSES.map((s) => (
              <option key={s} value={s}>{s.replace(/_/g, " ")}</option>
            ))}
          </select>
          <button className="btn" type="submit">Save</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Budget vs actual — {budgetCurrency}</div>
        <div className="grid cols-4 mt-3">
          <div className="card stat"><div className="k">Budgeted</div><div className="v" style={{ fontSize: "1.4rem" }}>{fmt(budgetForecast.budgetVsActual.totals.budgeted)}</div></div>
          <div className="card stat"><div className="k">Actual</div><div className="v" style={{ fontSize: "1.4rem" }}>{fmt(budgetForecast.budgetVsActual.totals.actual)}</div></div>
          <div className="card stat"><div className="k">Variance</div><div className="v" style={{ fontSize: "1.4rem", color: budgetForecast.budgetVsActual.totals.variance.startsWith("-") ? "var(--danger)" : "var(--ok)" }}>{fmt(budgetForecast.budgetVsActual.totals.variance)}</div></div>
          <div className="card stat"><div className="k">Variance %</div><div className="v" style={{ fontSize: "1.4rem" }}>{budgetForecast.budgetVsActual.totals.variancePercent ?? "—"}%</div></div>
        </div>
      </div>

      <div className="card">
        <div className="card-title">Forecast curve by period</div>
        {budgetForecast.forecastCurve.length === 0 ? (
          <div className="empty mt-2">No periods defined.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Period</th><th className="num">Budgeted</th><th className="num">Actual</th><th className="num">Variance</th></tr>
              </thead>
              <tbody>
                {budgetForecast.forecastCurve.map((point) => (
                  <tr key={point.periodId}>
                    <td className="dim small">
                      {point.periodName ?? point.periodId}
                      <span className="dim"> · {point.startDate} → {point.endDate}</span>
                    </td>
                    <td className="num">{fmt(point.budgeted)}</td>
                    <td className="num">{fmt(point.actual)}</td>
                    <td className="num" style={{ color: point.variance.startsWith("-") ? "var(--danger)" : "var(--ok)" }}>{fmt(point.variance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Resource requirements</div>
        <div className="grid cols-4 mt-3">
          <div className="card stat"><div className="k">Assigned people</div><div className="v" style={{ fontSize: "1.4rem" }}>{resourceReq.totals.assignedPeople}</div></div>
          <div className="card stat"><div className="k">Planned hours</div><div className="v" style={{ fontSize: "1.4rem" }}>{resourceReq.totals.plannedHours}</div></div>
          <div className="card stat"><div className="k">Actual hours</div><div className="v" style={{ fontSize: "1.4rem" }}>{resourceReq.totals.actualHours}</div></div>
          <div className="card stat"><div className="k">Remaining hours</div><div className="v" style={{ fontSize: "1.4rem" }}>{resourceReq.totals.remainingHours}</div></div>
        </div>
        <div className="grid cols-3 mt-3">
          <div className="card stat"><div className="k">Open tasks</div><div className="v">{resourceReq.totals.openTasks}</div></div>
          <div className="card stat"><div className="k">Blocked</div><div className="v" style={{ color: resourceReq.totals.blockedTasks > 0 ? "var(--danger)" : undefined }}>{resourceReq.totals.blockedTasks}</div></div>
          <div className="card stat"><div className="k">Overdue</div><div className="v" style={{ color: resourceReq.totals.overdueTasks > 0 ? "var(--danger)" : undefined }}>{resourceReq.totals.overdueTasks}</div></div>
        </div>

        {resourceReq.people.length === 0 ? (
          <div className="empty mt-3">No assigned staff.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr>
                  <th>Person</th><th className="num">Planned h</th><th className="num">Actual h</th>
                  <th className="num">Remaining h</th><th className="num">Open</th>
                  <th className="num">Blocked</th><th className="num">Overdue</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {resourceReq.people.map((person) => (
                  <tr key={person.membershipId}>
                    <td>{person.name}</td>
                    <td className="num">{person.plannedHours}</td>
                    <td className="num">{person.actualHours}</td>
                    <td className="num">{person.remainingHours}</td>
                    <td className="num">{person.openTasks}</td>
                    <td className="num" style={{ color: person.blockedTasks > 0 ? "var(--danger)" : undefined }}>{person.blockedTasks}</td>
                    <td className="num" style={{ color: person.overdueTasks > 0 ? "var(--danger)" : undefined }}>{person.overdueTasks}</td>
                    <td><span className={`badge ${person.status === "overloaded" ? "danger" : person.status === "underallocated" ? "warn" : "ok"}`}>{person.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {resourceReq.unassigned.taskCount > 0 && (
          <p className="small muted mt-2">
            Unassigned: {resourceReq.unassigned.taskCount} task(s), {resourceReq.unassigned.plannedHours}h planned,
            {" "}{resourceReq.unassigned.remainingHours}h remaining.
          </p>
        )}
      </div>

      <div className="card">
        <div className="card-title">Project risks</div>
        {projectRisks.length === 0 ? (
          <div className="empty mt-2">No risks recorded.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Title</th><th>Impact</th><th>Likelihood</th><th>Exposure</th><th>Status</th><th>Review</th><th>Action</th></tr>
              </thead>
              <tbody>
                {projectRisks.map((r) => (
                  <tr key={r.id}>
                    <td>{r.title}</td>
                    <td><span className={`badge ${r.impact === "critical" || r.impact === "high" ? "danger" : r.impact === "medium" ? "warn" : ""}`}>{r.impact}</span></td>
                    <td>{r.likelihood}</td>
                    <td><span className={`badge ${r.exposure === "severe" ? "danger" : r.exposure === "high" ? "warn" : ""}`}>{r.exposure}</span></td>
                    <td>{r.status}</td>
                    <td>{r.needsReview ? <span className="badge danger">due</span> : r.reviewDate ? String(r.reviewDate) : "—"}</td>
                    <td>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <form action={createProjectRisk} className="stack gap-1 mt-3">
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
      </div>

      <div className="card">
        <div className="card-title">Project decisions</div>
        {projectDecisions.length === 0 ? (
          <div className="empty mt-2">No decisions recorded.</div>
        ) : (
          <div className="stack gap-2 mt-3">
            {projectDecisions.map((d) => (
              <div key={d.id} className="card">
                <div className="row between">
                  <strong>{d.title}</strong>
                  <span className={`badge ${d.status === "decided" ? "ok" : d.status === "reversed" ? "warn" : ""}`}>{d.statusLabel}</span>
                </div>
                {d.context && <p className="small muted mt-1">{d.context}</p>}
                {d.options.length > 0 && (
                  <ul className="small mt-1">
                    {d.options.map((o) => (
                      <li key={o.id} className={o.id === d.decidedOptionId ? "bold" : undefined}>
                        {o.label} {o.id === d.decidedOptionId && "✓"}
                      </li>
                    ))}
                  </ul>
                )}
                {d.rationale && <p className="small mt-1">Rationale: {d.rationale}</p>}
                {d.status !== "decided" && d.status !== "reversed" && (
                  <form action={decideProjectDecision} className="stack gap-1 mt-2">
                    <input type="hidden" name="decision_id" value={d.id} />
                    <input type="hidden" name="status" value="decided" />
                    <select name="option_id" className="input sm" required>
                      <option value="">Choose option…</option>
                      {d.options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <textarea name="rationale" className="input" placeholder="Rationale" rows={2} />
                    <button className="btn sm" type="submit">Record decision</button>
                  </form>
                )}
              </div>
            ))}
          </div>
        )}

        <form action={createProjectDecision} className="stack gap-1 mt-3">
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
      </div>

      <div className="card">
        <div className="card-title">Scenario comparison</div>
        {projectScenarios.length === 0 ? (
          <div className="empty mt-2">No scenarios recorded.</div>
        ) : (
          <>
            <div className="table-wrap mt-3">
              <table className="data">
                <thead>
                  <tr>
                    <th>Scenario</th><th className="num">Best</th><th className="num">Expected</th><th className="num">Worst</th><th>Chosen</th><th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {projectScenarios.map((s) => (
                    <tr key={s.id} className={s.chosen ? "highlight" : undefined}>
                      <td>{s.title} {s.id === scenarioComparison.preferredId && <span className="badge ok">advisory preferred</span>}</td>
                      <td className="num">{fmtMoney(s.bestCaseTotal, s.currency)}</td>
                      <td className="num">{fmtMoney(s.expectedTotal, s.currency)}</td>
                      <td className="num">{fmtMoney(s.worstCaseTotal, s.currency)}</td>
                      <td>{s.chosen ? "✓" : "—"}</td>
                      <td>
                        {!s.chosen && (
                          <form action={chooseProjectScenario}>
                            <input type="hidden" name="scenario_id" value={s.id} />
                            <button className="btn sm" type="submit">Choose</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {scenarioComparison.preferredId && (
              <p className="small muted mt-2">Advisory preference: {projectScenarios.find((s) => s.id === scenarioComparison.preferredId)?.title} — {scenarioComparison.reason}</p>
            )}
          </>
        )}

        <form action={createProjectScenario} className="stack gap-1 mt-3">
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
      </div>
    </div>
  );
}
