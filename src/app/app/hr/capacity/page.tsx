/**
 * HR → Capacity (§7.2). Per-employee workload from assigned, estimated, non-terminal
 * tasks via the pure capacity engine. "Recompute" writes weekly snapshots that the
 * Command Centre turns into over/under-allocation exceptions. Read-only otherwise.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { computeCapacityDetail, type CapacityTask } from "@/modules/work/capacity-detail";
import { HBarChart } from "@/components/charts";
import { recomputeCapacity } from "./actions";

export const metadata = { title: "Capacity — Singha Central" };
const CONTRACTED = 40; // default weekly hours until employee_profiles is populated
const RESERVED = 4; // operational reserve (meetings/recurring)

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

export default async function CapacityPage() {
  const p = await requireDepartment("hr");
  const db = supabaseAdmin();

  const [employees, tasks] = await Promise.all([
    safe<any>(() => db.from("profiles").select("id, username, full_name, department").eq("company_id", p.companyId).eq("is_active", true) as any),
    // actual/remaining exist after migration 0025; safe() degrades gracefully if not.
    safe<any>(() => db.from("tasks").select("assigned_to, estimate_hours, actual_hours, remaining_hours, status, due_date").eq("company_id", p.companyId).not("assigned_to", "is", null) as any),
  ]);

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

  const rows = employees
    .map((e) => {
      const cap = computeCapacityDetail({
        contractedWeeklyHours: CONTRACTED,
        approvedLeaveHours: 0,
        holidayHours: 0,
        reservedHours: RESERVED,
        tasks: tasksByUser.get(e.id) ?? [],
      });
      return { name: e.full_name || e.username, department: e.department, cap };
    })
    .sort((a, b) => (Number(b.cap.utilizationPct) || 0) - (Number(a.cap.utilizationPct) || 0));

  const statusBadge = (s: string) => (s === "overloaded" ? "danger" : s === "underallocated" ? "info" : "ok");

  // Chart scaling only: ∞ utilization (open work but no net hours) draws as the longest bar;
  // the displayed value stays the exact table figure ("∞"). Percentages are not money.
  const maxUtil = Math.max(100, ...rows.map((r) => (Number.isFinite(r.cap.utilizationPct) ? r.cap.utilizationPct : 0)));

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Capacity</h1>
          <p className="muted mt-1">Planned vs actual vs remaining effort from assigned tasks ({CONTRACTED}h week, {RESERVED}h reserved). Reproducible from records.</p>
        </div>
        <form action={recomputeCapacity}><button className="btn ghost sm" type="submit">Recompute snapshots</button></form>
      </div>

      {rows.length > 0 && (
        <div className="card">
          <div className="card-title">Utilization by person</div>
          <div className="card-sub">Rebalance work from the red (overloaded) bars onto the dim (under-allocated) ones.</div>
          <div className="mt-2">
            <HBarChart
              data={rows.map((r) => ({
                label: r.name,
                display: Number.isFinite(r.cap.utilizationPct) ? `${r.cap.utilizationPct}%` : "∞",
                value: Number.isFinite(r.cap.utilizationPct) ? r.cap.utilizationPct : maxUtil,
                // Tone follows the SAME engine status the table badges use (overload 100% / under 60%),
                // plus an approaching-overload band above 85% within "healthy".
                tone:
                  r.cap.status === "overloaded" ? "danger"
                  : r.cap.status === "underallocated" ? "dim"
                  : r.cap.utilizationPct > 85 ? "warn"
                  : "accent",
              }))}
            />
          </div>
        </div>
      )}

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No active employees, or no assigned/estimated tasks yet. Assign tasks with estimates in Operations.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr>
                <th>Employee</th><th className="num">Planned</th><th className="num">Actual</th>
                <th className="num">Remaining</th><th className="num">Free</th><th className="num">Blocked</th>
                <th className="num">Overdue</th><th className="num">Util.</th><th>Status</th>
              </tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.name} <span className="dim small">· {r.department}</span></td>
                    <td className="num">{r.cap.plannedHours}h</td>
                    <td className="num">{r.cap.actualHours}h</td>
                    <td className="num">{r.cap.remainingHours}h</td>
                    <td className="num" style={{ color: r.cap.freeHours < 0 ? "var(--danger)" : undefined }}>{r.cap.freeHours}h</td>
                    <td className="num">{r.cap.blockedTasks || ""}</td>
                    <td className="num" style={{ color: r.cap.overdueTasks ? "var(--danger)" : undefined }}>{r.cap.overdueTasks || ""}</td>
                    <td className="num">{Number.isFinite(r.cap.utilizationPct) ? `${r.cap.utilizationPct}%` : "∞"}</td>
                    <td><span className={`badge ${statusBadge(r.cap.status)}`}>{r.cap.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <p className="muted small">Command Centre reads the snapshots you recompute here for over/under-allocation alerts. <Link href="/app/command">Open →</Link></p>
    </div>
  );
}
