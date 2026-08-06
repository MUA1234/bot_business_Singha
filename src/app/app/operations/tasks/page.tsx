/**
 * Operations → Tasks. Wires the pure task lifecycle (src/modules/work/task-lifecycle)
 * to real, company-scoped data: create a task and move it through legal transitions
 * only. Read/writes are company-scoped and audited; degrades gracefully before the
 * Phase-2 tables exist (empty state, never a crash).
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { allowedTransitions, type TaskState } from "@/modules/work/task-lifecycle";
import { scorePriority } from "@/management/ai-manager/priority";
import { createTask, setTaskStatus } from "./actions";

export const metadata = { title: "Tasks — Singha" };

interface TaskRow {
  id: string;
  title: string;
  status: TaskState;
  requires_evidence: boolean;
  due_date: string | null;
  priority: number | null;
}

export default async function OpsTasks() {
  const p = await requireDepartment("operations");

  let rows: TaskRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("tasks")
      .select("id, title, status, requires_evidence, due_date, priority")
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: false })
      .limit(200);
    rows = (data ?? []) as TaskRow[];
  } catch {
    rows = []; // table not created yet (pre-migration)
  }

  // Rank most-urgent first (pure §6.2 scorer).
  const now = new Date();
  rows = rows.sort(
    (a, b) =>
      scorePriority({ status: b.status, dueDate: b.due_date, basePriority: b.priority }, now) -
      scorePriority({ status: a.status, dueDate: a.due_date, basePriority: a.priority }, now),
  );

  return (
    <div className="stack gap-3">
      <div>
        <h1>Tasks</h1>
        <p className="muted mt-1">Create work and move it through its lifecycle. Completion needs verified evidence.</p>
      </div>

      <div className="card">
        <div className="card-title">New task</div>
        <form action={createTask} className="stack gap-2 mt-2" style={{ maxWidth: 560 }}>
          <input name="title" className="input" placeholder="Task title" required />
          <textarea name="description" className="textarea" placeholder="Description (optional)" />
          <label className="row gap-1 small muted">
            <input type="checkbox" name="requires_evidence" /> Requires evidence before it can be completed
          </label>
          <button className="btn" type="submit">Create task</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">All tasks ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No tasks yet. Create one above (needs the Phase-2 tables applied).</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr><th>Task</th><th>Status</th><th>Due</th><th>Move to</th></tr>
              </thead>
              <tbody>
                {rows.map((t) => {
                  // Offer legal transitions, minus "completed" (that needs the evidence flow).
                  const moves = allowedTransitions(t.status).filter((s) => s !== "completed");
                  return (
                    <tr key={t.id}>
                      <td style={{ fontWeight: 600 }}>
                        <Link href={`/app/operations/tasks/${t.id}`}>{t.title}</Link>
                      </td>
                      <td><span className="badge">{t.status.replace(/_/g, " ")}</span></td>
                      <td className="dim small">{t.due_date ?? "—"}</td>
                      <td>
                        <div className="row gap-1 wrap">
                          {moves.length === 0 ? (
                            <span className="small dim">—</span>
                          ) : (
                            moves.map((to) => (
                              <form action={setTaskStatus} key={to}>
                                <input type="hidden" name="task_id" value={t.id} />
                                <input type="hidden" name="to" value={to} />
                                <button className="btn ghost sm" type="submit">{to.replace(/_/g, " ")}</button>
                              </form>
                            ))
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
