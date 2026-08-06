/**
 * Operations overview — live task dashboard (§10). Counts + the exception detector
 * over current tasks. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { detectTaskExceptions, type TaskLike } from "@/management/ai-manager/exceptions";

export const metadata = { title: "Operations — Singha" };
const TERMINAL = new Set(["completed", "cancelled"]);

export default async function OperationsHome() {
  const p = await requireDepartment("operations");
  const now = new Date();

  let tasks: any[] = [];
  try {
    tasks = (await supabaseReadClient().from("tasks").select("id, title, status, due_date, priority").eq("company_id", p.companyId).limit(500)).data ?? [];
  } catch {
    tasks = [];
  }

  const open = tasks.filter((t) => !TERMINAL.has(t.status));
  const blocked = open.filter((t) => t.status === "blocked").length;
  const inProgress = open.filter((t) => t.status === "in_progress").length;
  const exceptions = detectTaskExceptions(tasks.map((t): TaskLike => ({ id: t.id, title: t.title, status: t.status, dueDate: t.due_date, lastCheckInAt: null, estimateHours: null })), now);

  const tiles = [
    { k: "Open tasks", v: open.length },
    { k: "In progress", v: inProgress },
    { k: "Blocked", v: blocked, danger: blocked > 0 },
    { k: "Exceptions", v: exceptions.length, danger: exceptions.some((e) => e.severity === "critical") },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Operations</h1><p className="muted mt-1">Fulfilment, tasks and delivery.</p></div>
        <Link className="btn sm" href="/app/operations/tasks">Tasks →</Link>
      </div>
      <div className="grid cols-4">
        {tiles.map((t) => (
          <div key={t.k} className="card stat"><div className="k">{t.k}</div><div className="v" style={{ fontSize: "1.8rem", color: t.danger ? "var(--danger)" : undefined }}>{t.v}</div></div>
        ))}
      </div>
      <div className="card">
        <div className="card-title">Needs attention</div>
        {exceptions.length === 0 ? <div className="empty">Nothing flagged.</div> : (
          <div className="stack gap-1 mt-2">
            {exceptions.slice(0, 12).map((e, i) => (
              <div key={i} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                {e.taskId ? <Link href={`/app/operations/tasks/${e.taskId}`}>{e.message}</Link> : <span>{e.message}</span>}
                <span className={`badge ${e.severity === "critical" ? "danger" : e.severity === "warn" ? "warn" : "info"}`}>{e.type.replace(/_/g, " ")}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
