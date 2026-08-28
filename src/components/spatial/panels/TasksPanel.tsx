/**
 * Reusable Work panel — the Work Command Centre.
 *
 * Used by `/app/operations/tasks` and by the spatial workspace. The caller must
 * enforce permission (operations department or admin).
 *
 * The management default arranges work as a CONSTELLATION — grouped by the
 * dimension that actually decides what someone does next: overdue, blocked,
 * due soon, in flight, waiting on a decision, done. Every node is a real task
 * row and opens that task.
 *
 * The constellation is a default, not a cage: a list view (the full table, with
 * the same lifecycle transitions as before) and a board view (by state) are one
 * control away, and the choice is remembered per person.
 *
 * Behaviour preserved exactly: the same query, the same `scorePriority` ordering,
 * the same `allowedTransitions` gating, the same create form.
 */
import Link from "next/link";
import { supabaseReadClient } from "@/lib/supabase/read";
import { allowedTransitions, TASK_STATES, type TaskState } from "@/modules/work/task-lifecycle";
import { scorePriority } from "@/management/ai-manager/priority";
import { createTask, setTaskStatus } from "@/app/app/operations/tasks/actions";
import { SpatialForm } from "@/components/spatial/SpatialForm";
import { Badge, DataTable, type DataTableColumn, FormField } from "@/components/ui";
import { fmtDate } from "@/lib/format";
import { ViewSwitcher } from "@/components/os/ViewSwitcher";
import {
  Constellation,
  PageHead,
  Section,
  StateNote,
  type Cluster,
  type ConstellationNode,
} from "@/components/os/primitives";

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

const TERMINAL = new Set<TaskState>(["completed", "cancelled"] as TaskState[]);

/** Days from today until a date, or null when there is no date. */
function daysUntil(due: string | null, now: Date): number | null {
  if (!due) return null;
  const t = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((t - start) / 86_400_000);
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

  // ── Constellation: grouped by what decides the next action ─────────────
  const toNode = (t: TaskRow, band: ConstellationNode["band"], meta?: string): ConstellationNode => ({
    id: t.id,
    label: t.title,
    meta,
    band,
    href: `/app/operations/tasks/${t.id}`,
    icon: t.requires_evidence ? "paperclip" : undefined,
  });

  const overdue: ConstellationNode[] = [];
  const blocked: ConstellationNode[] = [];
  const dueSoon: ConstellationNode[] = [];
  const waiting: ConstellationNode[] = [];
  const inFlight: ConstellationNode[] = [];
  const done: ConstellationNode[] = [];
  const undated: ConstellationNode[] = [];

  for (const t of rows) {
    if (TERMINAL.has(t.status)) {
      done.push(toNode(t, "done"));
      continue;
    }
    if (t.status === "blocked") {
      blocked.push(toNode(t, "blocked"));
      continue;
    }
    const d = daysUntil(t.due_date, now);
    if (t.status === "overdue" || (d !== null && d < 0)) {
      overdue.push(toNode(t, "critical", d === null ? undefined : `${Math.abs(d)}d late`));
      continue;
    }
    if (t.status === "awaiting_estimate" || t.status === "verification") {
      waiting.push(toNode(t, "high", t.status.replace(/_/g, " ")));
      continue;
    }
    if (d !== null && d <= 7) {
      dueSoon.push(toNode(t, "high", d === 0 ? "today" : `${d}d`));
      continue;
    }
    if (d === null) {
      undated.push(toNode(t, "normal"));
      continue;
    }
    inFlight.push(toNode(t, "normal", fmtDate(t.due_date)));
  }

  const clusters: Cluster[] = [
    { key: "overdue", name: "Past its due date", nodes: overdue },
    { key: "blocked", name: "Blocked — waiting on someone", nodes: blocked },
    { key: "waiting", name: "Waiting on a decision", nodes: waiting },
    { key: "due-soon", name: "Due within seven days", nodes: dueSoon },
    { key: "in-flight", name: "In flight", nodes: inFlight },
    { key: "undated", name: "No due date recorded", nodes: undated },
    { key: "done", name: "Closed", nodes: done },
  ];

  // ── List view: the full table, unchanged in behaviour ──────────────────
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

  // ── Board view: one column per state that actually has work in it ──────
  const byState = new Map<TaskState, TaskRow[]>();
  for (const t of rows) {
    const list = byState.get(t.status) ?? [];
    list.push(t);
    byState.set(t.status, list);
  }
  const boardStates = TASK_STATES.filter((s) => (byState.get(s)?.length ?? 0) > 0);

  const listView =
    rows.length === 0 ? (
      <StateNote kind="empty" title="No tasks yet">
        Create one above. Nothing is shown here that is not a task row in this company.
      </StateNote>
    ) : (
      <div className="card">
        <DataTable
          columns={columns}
          rows={rows}
          keyExtractor={(t) => t.id}
          emptyTitle="No tasks yet"
          emptyDescription="Create one above (needs the Phase-2 tables applied)."
        />
      </div>
    );

  const boardView =
    boardStates.length === 0 ? (
      <StateNote kind="empty" title="No work to arrange">
        No task rows exist for this company yet.
      </StateNote>
    ) : (
      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(boardStates.length, 4)}, minmax(0, 1fr))`,
          gap: "var(--sp-3)",
          alignItems: "start",
        }}
        className="board-grid"
      >
        {boardStates.map((state) => {
          const items = byState.get(state) ?? [];
          return (
            <section className="mat-smoked" style={{ padding: "var(--sp-3)" }} key={state}>
              <div className="cluster-head">
                <span className="cluster-name">{state.replace(/_/g, " ")}</span>
                <span className="cluster-count">{items.length}</span>
              </div>
              <div className="stack gap-1">
                {items.map((t) => (
                  <Link
                    key={t.id}
                    href={`/app/operations/tasks/${t.id}`}
                    className="matter"
                    data-band={t.status === "blocked" || t.status === "overdue" ? "critical" : "normal"}
                    style={{ padding: "var(--sp-3)" }}
                  >
                    <div className="matter-title">{t.title}</div>
                    <div className="small dim mt-1">
                      {t.due_date ? `Due ${fmtDate(t.due_date)}` : "No due date"}
                      {t.requires_evidence ? " · evidence required" : ""}
                    </div>
                  </Link>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    );

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      {!embedded && (
        <PageHead
          eyebrow="Work"
          title="Work command centre"
          lede="Every task in this company, arranged by what decides the next action. Completion needs verified evidence where the task requires it."
        />
      )}

      <Section title="New task" />
      <div className="card">
        <SpatialForm action={createTask} className="stack gap-2" style={{ maxWidth: 560 }} submitLabel="Create task">
          <FormField name="title" label="Title" placeholder="Task title" required />
          <FormField name="description" label="Description">
            <textarea name="description" className="textarea" placeholder="Description (optional)" rows={3} />
          </FormField>
          <label className="check small muted">
            <input type="checkbox" name="requires_evidence" /> Requires evidence before it can be completed
          </label>
        </SpatialForm>
      </div>

      <Section title="All work" meta={`${rows.length} task${rows.length === 1 ? "" : "s"}`} />
      <ViewSwitcher
        storageKey="singha.os.view.work"
        meta="Grouping is derived from status and due date — nothing is inferred"
        views={[
          {
            key: "constellation",
            label: "Constellation",
            icon: "network",
            node:
              rows.length === 0 ? (
                <StateNote kind="empty" title="No tasks yet">
                  Create one above. Nothing is shown here that is not a task row in this company.
                </StateNote>
              ) : (
                <div className="card pad-lg">
                  <Constellation clusters={clusters} />
                </div>
              ),
          },
          { key: "list", label: "List", icon: "rows", node: listView },
          { key: "board", label: "Board", icon: "grid", node: boardView },
        ]}
      />
    </div>
  );
}
