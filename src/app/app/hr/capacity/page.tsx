/**
 * HR → Capacity (§7.2). Per-employee workload from assigned, estimated, non-terminal
 * tasks via the pure capacity engine. "Recompute" writes weekly snapshots that the
 * Command Centre turns into over/under-allocation exceptions. Read-only otherwise.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { computeCapacity } from "@/modules/work/capacity";
import { recomputeCapacity } from "./actions";

export const metadata = { title: "Capacity — Singha" };
const CONTRACTED = 40;
const TERMINAL = new Set(["completed", "cancelled"]);

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
    safe<any>(() => db.from("tasks").select("assigned_to, estimate_hours, status").eq("company_id", p.companyId).not("assigned_to", "is", null) as any),
  ]);

  const allocByUser = new Map<string, number>();
  for (const t of tasks) {
    if (TERMINAL.has(t.status)) continue;
    allocByUser.set(t.assigned_to, (allocByUser.get(t.assigned_to) ?? 0) + Number(t.estimate_hours ?? 0));
  }

  const rows = employees
    .map((e) => {
      const allocated = allocByUser.get(e.id) ?? 0;
      const cap = computeCapacity({ contractedHours: CONTRACTED, leaveHours: 0, meetingHours: 0, recurringHours: 0, taskEstimateHours: allocated, contingencyPct: 0.1 });
      return { name: e.full_name || e.username, department: e.department, cap };
    })
    .sort((a, b) => b.cap.utilizationPct - a.cap.utilizationPct);

  const statusBadge = (s: string) => (s === "overloaded" ? "danger" : s === "underallocated" ? "info" : "ok");

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Capacity</h1>
          <p className="muted mt-1">Workload from assigned tasks (40h week, 10% buffer).</p>
        </div>
        <form action={recomputeCapacity}><button className="btn ghost sm" type="submit">Recompute snapshots</button></form>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No active employees, or no assigned/estimated tasks yet. Assign tasks with estimates in Operations.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Employee</th><th className="num">Allocated</th><th className="num">Available</th><th className="num">Utilisation</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{r.name} <span className="dim small">· {r.department}</span></td>
                    <td className="num">{r.cap.allocatedHours}h</td>
                    <td className="num" style={{ color: r.cap.availableHours < 0 ? "var(--danger)" : undefined }}>{r.cap.availableHours}h</td>
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
