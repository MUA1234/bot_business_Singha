/**
 * Operations → Projects — PRJ-001 project registry with lifecycle states, plus
 * PRJ-005 portfolio prioritisation that ranks projects by value, risk, capacity
 * and dependency using deterministic pure helpers.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { tasksWithAssignments } from "@/lib/embeds";
import { dec } from "@/lib/money";
import { rankProjectsByPriority, type ProjectPrioritisationInput } from "@/modules/project/portfolio-prioritisation";
import { computeResourceRequirements, type ResourceTaskInput, type ResourceAssignmentInput, type ResourceMembershipInput, type ResourceEmployeeInput } from "@/modules/project/resource-requirements";
import { Badge, DataTable, type DataTableColumn } from "@/components/ui";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata = { title: "Projects — Singha Central" };

interface Project {
  id: string;
  name: string;
  code: string | null;
  status: string;
  created_at: string;
}

interface ScenarioRow {
  project_id: string;
  expected_total: string;
  chosen: boolean;
}

interface RiskRow {
  project_id: string;
  impact: string;
  likelihood: string;
  status: string;
}

interface TaskRow {
  id: string;
  project_id: string;
  status: string;
  due_date: string | null;
  estimate_hours: number | null;
  actual_hours: number | null;
  remaining_hours: number | null;
  task_assignments: { membership_id: string | null; estimate_hours: number | null }[];
}

function statusVariant(status: string): BadgeVariant {
  if (status === "active") return "ok";
  if (status === "on_hold") return "warn";
  if (status === "cancelled") return "danger";
  return "default";
}

type BadgeVariant = "default" | "ok" | "warn" | "danger" | "info" | "accent";

function isBlockedOrOverdue(task: TaskRow, today: string): boolean {
  if (task.status === "blocked" || task.status === "escalated") return true;
  if (task.status === "completed" || task.status === "cancelled") return false;
  return task.due_date != null && task.due_date < today;
}

export default async function ProjectsPage() {
  const p = await requireDepartment("operations");
  const db = supabaseReadClient();
  const today = new Date().toISOString().slice(0, 10);

  const [
    projectsResult,
    scenariosResult,
    risksResult,
    tasksResult,
    membershipsResult,
    employeesResult,
  ] = await Promise.all([
    db.from("projects").select("id, name, code, status, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(500),
    db.from("project_scenarios").select("project_id, expected_total, chosen").eq("company_id", p.companyId),
    db.from("project_risks").select("project_id, impact, likelihood, status").eq("company_id", p.companyId),
    // NOT an embed — see src/lib/embeds.ts: three foreign keys make it ambiguous.
    tasksWithAssignments(db, p.companyId).then((data) => ({ data })),
    db.from("memberships").select("id, user_id").eq("company_id", p.companyId).eq("status", "active"),
    db.from("employee_profiles").select("membership_id, contracted_weekly_hours, reserved_weekly_hours").eq("company_id", p.companyId),
  ]);

  const projects: Project[] = (projectsResult.data ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    status: r.status,
    created_at: r.created_at,
  }));

  const scenarios: ScenarioRow[] = (scenariosResult.data ?? []).map((r: any) => ({
    project_id: r.project_id,
    expected_total: String(r.expected_total ?? 0),
    chosen: r.chosen,
  }));

  const risks: RiskRow[] = (risksResult.data ?? []).map((r: any) => ({
    project_id: r.project_id,
    impact: r.impact,
    likelihood: r.likelihood,
    status: r.status,
  }));

  const tasks: TaskRow[] = (tasksResult.data ?? []).map((t: any) => ({
    id: t.id,
    project_id: t.project_id,
    status: t.status,
    due_date: t.due_date,
    estimate_hours: t.estimate_hours != null ? Number(t.estimate_hours) : null,
    actual_hours: t.actual_hours != null ? Number(t.actual_hours) : null,
    remaining_hours: t.remaining_hours != null ? Number(t.remaining_hours) : null,
    task_assignments: (t.task_assignments ?? []).map((a: any) => ({
      membership_id: a.membership_id ?? null,
      estimate_hours: a.estimate_hours != null ? Number(a.estimate_hours) : null,
    })),
  }));

  const memberships: ResourceMembershipInput[] = (membershipsResult.data ?? []).map((m: any) => ({ id: m.id, user_id: m.user_id ?? null }));
  const membershipById = new Map(memberships.map((m) => [m.id, m]));
  const employees: ResourceEmployeeInput[] = (employeesResult.data ?? []).map((e: any) => {
    const membership = membershipById.get(e.membership_id);
    return {
      id: membership?.user_id ?? e.membership_id,
      full_name: null,
      username: null,
      contracted_weekly_hours: e.contracted_weekly_hours != null ? Number(e.contracted_weekly_hours) : null,
      reserved_weekly_hours: e.reserved_weekly_hours != null ? Number(e.reserved_weekly_hours) : null,
    };
  });

  const projectIds = projects.map((proj) => proj.id);
  const priorityByProject = new Map<string, ReturnType<typeof rankProjectsByPriority>[number]>();

  if (projectIds.length > 0) {
    const inputs: ProjectPrioritisationInput[] = [];
    for (const proj of projects) {
      const projectTasks = tasks.filter((t) => t.project_id === proj.id);
      const assignments: ResourceAssignmentInput[] = [];
      for (const t of projectTasks) {
        for (const a of t.task_assignments) {
          if (a.membership_id) {
            assignments.push({ id: `${t.id}-${a.membership_id}`, task_id: t.id, membership_id: a.membership_id, estimate_hours: a.estimate_hours });
          }
        }
      }
      const resourceReq = computeResourceRequirements({
        projectId: proj.id,
        tasks: projectTasks.map((t): ResourceTaskInput => ({
          id: t.id,
          project_id: t.project_id,
          status: t.status as any,
          title: "",
          estimate_hours: t.estimate_hours,
          actual_hours: t.actual_hours,
          remaining_hours: t.remaining_hours,
          due_date: t.due_date,
        })),
        assignments,
        memberships,
        employees,
        today,
      });

      const projectScenarios = scenarios.filter((s) => s.project_id === proj.id);
      const chosen = projectScenarios.find((s) => s.chosen);
      const valueTotal = chosen
        ? chosen.expected_total
        : projectScenarios.length > 0
          ? projectScenarios.reduce((best, s) => (dec(s.expected_total).greaterThan(dec(best)) ? s.expected_total : best), projectScenarios[0]!.expected_total)
          : "0";

      inputs.push({
        projectId: proj.id,
        name: proj.name,
        valueTotal,
        openRisks: risks.filter((r) => r.project_id === proj.id && r.status === "open").map((r) => ({ impact: r.impact as any, likelihood: r.likelihood as any })),
        overloadedPeople: resourceReq.people.filter((person) => person.status === "overloaded").length,
        overdueOrBlockedTasks: projectTasks.filter((t) => isBlockedOrOverdue(t, today)).length,
      });
    }

    for (const item of rankProjectsByPriority(inputs)) {
      priorityByProject.set(item.projectId, item);
    }
  }

  const sortedProjects = [...projects].sort((a, b) => {
    const pa = priorityByProject.get(a.id)?.score ?? Infinity;
    const pb = priorityByProject.get(b.id)?.score ?? Infinity;
    return pa - pb;
  });

  const columns: DataTableColumn<Project & { index: number }>[] = [
    {
      key: "priority",
      header: "Priority",
      render: (row) => <Badge variant="ok">#{row.index}</Badge>,
    },
    {
      key: "project",
      header: "Project",
      render: (proj) => (
        <Link className="link" href={`/app/operations/projects/${proj.id}`} style={{ fontWeight: 600 }}>
          {proj.name}
        </Link>
      ),
    },
    {
      key: "code",
      header: "Code",
      className: "dim small mono",
      render: (proj) => proj.code ?? "—",
    },
    {
      key: "status",
      header: "Status",
      render: (proj) => <Badge variant={statusVariant(proj.status)}>{proj.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "valueRank",
      header: "Value rank",
      align: "right",
      render: (proj) => priorityByProject.get(proj.id)?.valueRank ?? "—",
    },
    {
      key: "riskRank",
      header: "Risk rank",
      align: "right",
      render: (proj) => priorityByProject.get(proj.id)?.riskRank ?? "—",
    },
    {
      key: "capacityRank",
      header: "Capacity rank",
      align: "right",
      render: (proj) => priorityByProject.get(proj.id)?.capacityRank ?? "—",
    },
    {
      key: "dependencyRank",
      header: "Dependency rank",
      align: "right",
      render: (proj) => priorityByProject.get(proj.id)?.dependencyRank ?? "—",
    },
    {
      key: "created",
      header: "Created",
      className: "dim small",
      render: (proj) => fmtDate(proj.created_at),
    },
  ];

  const tableRows = sortedProjects.map((proj, idx) => ({ ...proj, index: idx + 1 }));

  // The projects that most need a decision, shown as spatial matters ahead of
  // the full register. "Needs attention" is derived, not asserted: a project
  // qualifies when it carries open risks or overdue and blocked work — each of
  // which is a row count, not a judgement.
  const attention = tableRows
    .map((proj) => {
      const projectTasks = tasks.filter((t) => t.project_id === proj.id);
      const stuck = projectTasks.filter((t) => isBlockedOrOverdue(t, today)).length;
      const openRisks = risks.filter((r) => r.project_id === proj.id && r.status === "open").length;
      return { proj, stuck, openRisks, total: projectTasks.length };
    })
    .filter((x) => x.stuck > 0 || x.openRisks > 0)
    .slice(0, 6);

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Projects"
        title="Project portfolio"
        lede="Every project, ranked by a weighted combination of value, risk, capacity pressure and overdue or blocked dependencies. The ranking is deterministic and reproducible from the records it reads."
        actions={<Link className="btn ghost sm" href="/app/operations">Operations</Link>}
      />

      {attention.length > 0 && (
        <>
          <Section
            title="Projects needing a decision"
            meta={`${attention.length} of ${projects.length}`}
          />
          <div className="field-matters">
            {attention.map(({ proj, stuck, openRisks, total }) => (
              <Matter
                key={proj.id}
                kind={proj.code ?? "Project"}
                kindIcon="git-branch"
                band={stuck > 0 ? "critical" : "high"}
                title={proj.name}
                href={`/app/operations/projects/${proj.id}`}
                facts={[
                  { k: "State", v: proj.status.replace(/_/g, " ") },
                  { k: "Overdue or blocked", v: String(stuck), numeric: true },
                  { k: "Open risks", v: String(openRisks), numeric: true },
                  { k: "Tasks", v: String(total), numeric: true },
                  { k: "Priority rank", v: `#${proj.index}` },
                ]}
                footer={
                  stuck > 0 ? (
                    <Signal kind="critical">Work is stuck on this project</Signal>
                  ) : (
                    <Signal kind="warn">Open risks recorded against it</Signal>
                  )
                }
              />
            ))}
          </div>
        </>
      )}

      <Section
        title="Project registry"
        meta={`${projects.length} project${projects.length === 1 ? "" : "s"}, most urgent first`}
      />
      {tableRows.length === 0 ? (
        <StateNote kind="empty" title="No projects yet">
          Create a project to see it ranked against the rest of the portfolio.
        </StateNote>
      ) : (
        <div className="card">
          <DataTable
            columns={columns}
            rows={tableRows}
            keyExtractor={(r) => r.id}
            emptyTitle="No projects yet"
            emptyDescription="Create a project to see it ranked."
          />
          <p className="small muted mt-2">
            Priority is a weighted combination of value (higher is better), risk, capacity pressure
            and overdue or blocked dependencies. A dash means the input for that dimension has not
            been recorded — it is not a zero.
          </p>
        </div>
      )}
    </div>
  );
}
