/**
 * People & workforce command centre.
 *
 * The centrepiece is an ORGANISATION CONSTELLATION: every active person in the
 * company, clustered by the department they belong to, with their current
 * workload state attached.
 *
 * What it deliberately does NOT do (§23): it does not score humans. The band on
 * a person comes from the capacity engine — assigned, estimated, non-terminal
 * task hours against contracted hours — which is operational information about
 * WORK, reproducible from records. There is no performance rating, no ranking
 * and no inferred judgement about a person anywhere on this screen.
 *
 * Company-scoped and graceful: a missing table degrades to an empty cluster
 * rather than a failed page.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { computeCapacityDetail, type CapacityTask } from "@/modules/work/capacity-detail";
import { getDepartment } from "@/lib/departments";
import { fmtNumber } from "@/lib/format";
import {
  Constellation,
  Matter,
  PageHead,
  Section,
  Signal,
  StateNote,
  type Cluster,
  type ConstellationNode,
} from "@/components/os/primitives";

export const metadata = { title: "People — Singha Central" };

/** Contracted week and operational reserve, matching /app/hr/capacity. */
const CONTRACTED = 40;
const RESERVED = 4;

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try { return (await run()).count ?? 0; } catch { return 0; }
}
async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try { return (await run()).data ?? []; } catch { return []; }
}

export default async function HrHome() {
  const p = await requireDepartment("hr");
  const db = supabaseReadClient();

  const [staff, pendingLeave, caps, people, tasks] = await Promise.all([
    count(() => db.from("profiles").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("is_active", true) as any),
    count(() => db.from("leave_requests").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "pending") as any),
    rows<any>(() => db.from("capacity_snapshots").select("status, week_start").eq("company_id", p.companyId).order("week_start", { ascending: false }).limit(200) as any),
    rows<any>(() => db.from("profiles").select("id, username, full_name, department").eq("company_id", p.companyId).eq("is_active", true) as any),
    rows<any>(() => db.from("tasks").select("assigned_to, estimate_hours, actual_hours, remaining_hours, status, due_date").eq("company_id", p.companyId).not("assigned_to", "is", null) as any),
  ]);

  const latestWeek = caps[0]?.week_start;
  const thisWeek = caps.filter((c) => c.week_start === latestWeek);
  const overloaded = thisWeek.filter((c) => c.status === "overloaded").length;

  // ── The constellation ──────────────────────────────────────────────────
  const tasksByUser = new Map<string, CapacityTask[]>();
  for (const t of tasks) {
    const list = tasksByUser.get(t.assigned_to) ?? [];
    list.push({
      status: t.status,
      estimateHours: t.estimate_hours != null ? Number(t.estimate_hours) : null,
      actualHours: t.actual_hours != null ? Number(t.actual_hours) : null,
      remainingHours: t.remaining_hours != null ? Number(t.remaining_hours) : null,
      dueDate: t.due_date ?? null,
    });
    tasksByUser.set(t.assigned_to, list);
  }

  const byDepartment = new Map<string, ConstellationNode[]>();
  let unassignedWork = 0;
  for (const person of people) {
    const cap = computeCapacityDetail({
      contractedWeeklyHours: CONTRACTED,
      approvedLeaveHours: 0,
      holidayHours: 0,
      reservedHours: RESERVED,
      tasks: tasksByUser.get(person.id) ?? [],
    });
    const band: ConstellationNode["band"] =
      cap.status === "overloaded" ? "critical" : cap.overdueTasks > 0 ? "high" : cap.blockedTasks > 0 ? "blocked" : "normal";
    const util = Number.isFinite(cap.utilizationPct) ? `${fmtNumber(cap.utilizationPct, 0)}%` : "∞";
    const key = person.department ?? "unassigned";
    const list = byDepartment.get(key) ?? [];
    list.push({
      id: person.id,
      label: person.full_name || person.username,
      meta: util,
      band,
      href: `/app/hr/staff/${person.id}`,
      icon: "user-round",
    });
    byDepartment.set(key, list);
  }
  for (const t of tasks) {
    if (!t.assigned_to) unassignedWork++;
  }

  const clusters: Cluster[] = [...byDepartment.entries()]
    .map(([key, nodes]) => ({
      key,
      name: getDepartment(key)?.label ?? (key === "unassigned" ? "No department recorded" : key),
      nodes: nodes.sort((a, b) => a.label.localeCompare(b.label)),
    }))
    .sort((a, b) => b.nodes.length - a.nodes.length);

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="People"
        title="Workforce"
        lede="Who is here, what they are carrying and who is unavailable. Workload comes from assigned, estimated tasks — this screen holds no performance rating and makes no judgement about a person."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/hr/capacity">Capacity detail</Link>
            <Link className="btn ghost sm" href="/app/hr/staff">Staff records</Link>
          </>
        }
      />

      <Section title="Position" />
      <div className="grid cols-3">
        <Link href="/app/hr/staff" className="card stat">
          <div className="k">Active staff</div>
          <div className="v">{fmtNumber(staff)}</div>
          <div className="d">Profiles marked active in this company</div>
        </Link>
        <Link href="/app/hr/leave" className="card stat">
          <div className="k">Leave awaiting a decision</div>
          <div className="v">{fmtNumber(pendingLeave)}</div>
          <div className="d">
            {pendingLeave > 0 ? (
              <Signal kind="warn">Someone is waiting on an answer</Signal>
            ) : (
              <Signal kind="ok">Nothing pending</Signal>
            )}
          </div>
        </Link>
        <Link href="/app/hr/capacity" className="card stat">
          <div className="k">Over declared capacity</div>
          <div className="v">{fmtNumber(overloaded)}</div>
          <div className="d">
            {caps.length === 0 ? (
              <Signal kind="offline">No capacity snapshots recorded yet</Signal>
            ) : overloaded > 0 ? (
              <Signal kind="critical">From the latest recorded week</Signal>
            ) : (
              <Signal kind="ok">Nobody over capacity this week</Signal>
            )}
          </div>
        </Link>
      </div>

      {(pendingLeave > 0 || overloaded > 0 || unassignedWork > 0) && (
        <>
          <Section title="Needs a decision" />
          <div className="field-matters">
            {overloaded > 0 && (
              <Matter
                kind="Capacity"
                kindIcon="gauge"
                band="critical"
                title={`${overloaded} ${overloaded === 1 ? "person is" : "people are"} above declared capacity`}
                href="/app/hr/capacity"
                facts={[
                  { k: "Basis", v: "Recorded capacity snapshots" },
                  { k: "Week", v: latestWeek ?? "", missing: !latestWeek },
                  { k: "Contracted week", v: `${CONTRACTED} h` },
                  { k: "Reserved", v: `${RESERVED} h` },
                ]}
                footer={<Signal kind="critical">Rebalance before more work is assigned</Signal>}
              />
            )}
            {pendingLeave > 0 && (
              <Matter
                kind="Leave"
                kindIcon="calendar-days"
                band="high"
                title={`${pendingLeave} leave request${pendingLeave === 1 ? "" : "s"} awaiting a decision`}
                href="/app/hr/leave"
                footer={<Signal kind="warn">A person is waiting on an answer</Signal>}
              />
            )}
            {unassignedWork > 0 && (
              <Matter
                kind="Unassigned work"
                kindIcon="list-todo"
                band="normal"
                title={`${unassignedWork} task${unassignedWork === 1 ? "" : "s"} have no owner`}
                href="/app/operations/tasks"
                footer={<Signal kind="info">Work with nobody accountable for it</Signal>}
              />
            )}
          </div>
        </>
      )}

      <Section
        title="Organisation"
        meta="grouped by department · the figure is workload against a 40-hour week"
      />
      {people.length === 0 ? (
        <StateNote kind="empty" title="No active staff records">
          Once employee profiles exist for this company, the organisation appears here grouped by
          department.
        </StateNote>
      ) : (
        <div className="card pad-lg">
          <Constellation clusters={clusters} />
          <div className="mt-3 row wrap gap-3">
            <Signal kind="critical">Over capacity</Signal>
            <Signal kind="warn">Carrying overdue work</Signal>
            <Signal kind="blocked">Carrying blocked work</Signal>
            <Signal kind="info">Within capacity</Signal>
          </div>
        </div>
      )}
    </div>
  );
}
