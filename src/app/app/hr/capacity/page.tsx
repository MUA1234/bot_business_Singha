/**
 * HR → Capacity (§7.2). Per-employee workload from assigned, estimated, non-terminal
 * tasks via the pure capacity engine. "Recompute" writes weekly snapshots that the
 * Command Centre turns into over/under-allocation exceptions. Read-only otherwise.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { computeCapacityDetail, type CapacityDetail, type CapacityTask } from "@/modules/work/capacity-detail";
import { HBarChart } from "@/components/charts";
import { recomputeCapacity } from "./actions";
import { Card, CardHeader, CardBody, Button, Badge, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtNumber } from "@/lib/format";

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

interface Employee {
  id: string;
  username: string;
  full_name: string | null;
  department: string | null;
}

interface CapacityRow {
  id: string;
  name: string;
  department: string | null;
  cap: CapacityDetail;
}

export default async function CapacityPage() {
  const p = await requireDepartment("hr");
  const db = supabaseReadClient();

  const [employees, tasks] = await Promise.all([
    safe<Employee>(() =>
      db.from("profiles").select("id, username, full_name, department").eq("company_id", p.companyId).eq("is_active", true) as any,
    ),
    // actual/remaining exist after migration 0025; safe() degrades gracefully if not.
    safe<any>(() =>
      db.from("tasks").select("assigned_to, estimate_hours, actual_hours, remaining_hours, status, due_date").eq("company_id", p.companyId).not("assigned_to", "is", null) as any,
    ),
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

  const rows: CapacityRow[] = employees
    .map((e) => {
      const cap = computeCapacityDetail({
        contractedWeeklyHours: CONTRACTED,
        approvedLeaveHours: 0,
        holidayHours: 0,
        reservedHours: RESERVED,
        tasks: tasksByUser.get(e.id) ?? [],
      });
      return { id: e.id, name: e.full_name || e.username, department: e.department, cap };
    })
    .sort((a, b) => (Number(b.cap.utilizationPct) || 0) - (Number(a.cap.utilizationPct) || 0));

  // Chart scaling only: ∞ utilization (open work but no net hours) draws as the longest bar;
  // the displayed value stays the exact table figure ("∞"). Percentages are not money.
  const maxUtil = Math.max(100, ...rows.map((r) => (Number.isFinite(r.cap.utilizationPct) ? r.cap.utilizationPct : 0)));

  const statusVariant = (s: CapacityDetail["status"]) =>
    s === "overloaded" ? "danger" : s === "underallocated" ? "info" : "ok";

  const columns: DataTableColumn<CapacityRow>[] = [
    {
      key: "employee",
      header: "Employee",
      render: (r) => (
        <div style={{ fontWeight: 600 }}>
          {r.name} <span className="dim small">· {r.department ?? "—"}</span>
        </div>
      ),
    },
    { key: "planned", header: "Planned", align: "right", render: (r) => `${fmtNumber(r.cap.plannedHours, 2)}h` },
    { key: "actual", header: "Actual", align: "right", render: (r) => `${fmtNumber(r.cap.actualHours, 2)}h` },
    { key: "remaining", header: "Remaining", align: "right", render: (r) => `${fmtNumber(r.cap.remainingHours, 2)}h` },
    {
      key: "free",
      header: "Free",
      align: "right",
      render: (r) => (
        <span style={{ color: r.cap.freeHours < 0 ? "var(--danger)" : undefined }}>
          {fmtNumber(r.cap.freeHours, 2)}h
        </span>
      ),
    },
    {
      key: "blocked",
      header: "Blocked",
      align: "right",
      render: (r) => (r.cap.blockedTasks ? fmtNumber(r.cap.blockedTasks) : "—"),
    },
    {
      key: "overdue",
      header: "Overdue",
      align: "right",
      render: (r) => (
        <span style={{ color: r.cap.overdueTasks ? "var(--danger)" : undefined }}>
          {r.cap.overdueTasks ? fmtNumber(r.cap.overdueTasks) : "—"}
        </span>
      ),
    },
    {
      key: "util",
      header: "Util.",
      align: "right",
      render: (r) => (Number.isFinite(r.cap.utilizationPct) ? `${fmtNumber(r.cap.utilizationPct, 2)}%` : "∞"),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <Badge variant={statusVariant(r.cap.status)}>{r.cap.status}</Badge>,
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Capacity</h1>
          <p className="muted mt-1">
            Planned vs actual vs remaining effort from assigned tasks ({CONTRACTED}h week, {RESERVED}h reserved). Reproducible from records.
          </p>
        </div>
        <form action={recomputeCapacity}>
          <Button variant="ghost" size="sm" type="submit">
            Recompute snapshots
          </Button>
        </form>
      </div>

      {rows.length > 0 && (
        <Card>
          <CardHeader
            title="Utilization by person"
            subtitle="Rebalance work from the red (overloaded) bars onto the dim (under-allocated) ones."
          />
          <CardBody>
            <HBarChart
              data={rows.map((r) => ({
                label: r.name,
                display: Number.isFinite(r.cap.utilizationPct) ? `${fmtNumber(r.cap.utilizationPct, 2)}%` : "∞",
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
          </CardBody>
        </Card>
      )}

      <Card>
        <CardHeader title="Capacity by person" />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No active employees, or no assigned/estimated tasks yet"
            emptyDescription="Assign tasks with estimates in Operations."
          />
        </CardBody>
      </Card>

      <p className="muted small">
        Command Centre reads the snapshots you recompute here for over/under-allocation alerts. <Link href="/app/command">Open →</Link>
      </p>
    </div>
  );
}
