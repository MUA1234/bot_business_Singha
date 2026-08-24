/**
 * Reusable Tasks panel. Used by `/app/operations/tasks` and by the spatial workspace.
 * The caller must enforce permission (operations department or admin).
 */
import Link from "next/link";
import { supabaseReadClient } from "@/lib/supabase/read";
import { allowedTransitions, type TaskState } from "@/modules/work/task-lifecycle";
import { scorePriority } from "@/management/ai-manager/priority";
import { createTask, setTaskStatus } from "@/app/app/operations/tasks/actions";
import { SpatialForm } from "@/components/spatial/SpatialForm";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn, FormField } from "@/components/ui";
import { fmtDate } from "@/lib/format";

interface TaskRow {
  id: string;
  title: string;
  status: TaskState;
  requires_evidence: boolean;
  due_date: string | null;
  priority: number | null;
}

interface TasksPanelProps {
  companyId: string;
  embedded?: boolean;
}

export async function TasksPanel({ companyId, embedded }: TasksPanelProps) {
  let rows: TaskRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("tasks")
      .select("id, title, status, requires_evidence, due_date, priority")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    rows = (data ?? []) as TaskRow[];
  } catch {
    rows = [];
  }

  const now = new Date();
  rows = rows.sort(
    (a, b) =>
      scorePriority({ status: b.status, dueDate: b.due_date, basePriority: b.priority }, now) -
      scorePriority({ status: a.status, dueDate: a.due_date, basePriority: a.priority }, now),
  );

  const columns: DataTableColumn<TaskRow>[] = [
    {
      key: "title",
      header: "Task",
      render: (t) => (
        <Link href={`/app/operations/tasks/${t.id}`} style={{ fontWeight: 600 }}>
          {t.title}
        </Link>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (t) => <Badge variant={t.status === "blocked" ? "danger" : t.status === "overdue" ? "danger" : "default"}>{t.status.replace(/_/g, " ")}</Badge>,
    },
    {
      key: "due",
      header: "Due",
      className: "dim small",
      render: (t) => fmtDate(t.due_date),
    },
    {
      key: "move",
      header: "Move to",
      render: (t) => {
        const moves = allowedTransitions(t.status).filter((s) => s !== "completed");
        if (moves.length === 0) return <span className="small dim">—</span>;
        return (
          <div className="row gap-1 wrap">
            {moves.map((to) => (
              <SpatialForm action={setTaskStatus} key={to} hidden={{ task_id: t.id, to }} submitLabel={to.replace(/_/g, " ")} submitVariant="ghost" submitSize="sm" />
            ))}
          </div>
        );
      },
    },
  ];

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div>
          <h1>Tasks</h1>
          <p className="muted mt-1">Create work and move it through its lifecycle. Completion needs verified evidence.</p>
        </div>
      )}

      <Card>
        <CardHeader title="New task" />
        <CardBody>
          <SpatialForm action={createTask} className="stack gap-2 mt-2" style={{ maxWidth: 560 }} submitLabel="Create task">
            <FormField name="title" label="Title" placeholder="Task title" required />
            <FormField name="description" label="Description">
              <textarea name="description" className="textarea" placeholder="Description (optional)" rows={3} />
            </FormField>
            <label className="row gap-1 small muted">
              <input type="checkbox" name="requires_evidence" /> Requires evidence before it can be completed
            </label>
          </SpatialForm>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`All tasks (${rows.length})`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(t) => t.id}
            emptyTitle="No tasks yet"
            emptyDescription="Create one above (needs the Phase-2 tables applied)."
          />
        </CardBody>
      </Card>
    </div>
  );
}
