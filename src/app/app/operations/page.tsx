/**
 * Operations overview — live task dashboard (§10). Counts + the exception detector
 * over current tasks. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { detectTaskExceptions, type TaskLike } from "@/management/ai-manager/exceptions";
import { BarChart, type BarDatum } from "@/components/charts";
import { TASK_STATES } from "@/modules/work/task-lifecycle";
import { Badge } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { fmtNumber } from "@/lib/format";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Operations — Singha Central" };
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

  // Task counts per status (counts, not money), only for statuses actually present, ordered by the
  // lifecycle. Blocked/overdue genuinely ARE states → reserved tones; everything else stays one hue.
  const byStatus = new Map<string, number>();
  for (const t of tasks) byStatus.set(String(t.status), (byStatus.get(String(t.status)) ?? 0) + 1);
  const lifecycle: readonly string[] = TASK_STATES;
  const statusData: BarDatum[] = [
    ...lifecycle.filter((s) => byStatus.has(s)),
    ...[...byStatus.keys()].filter((s) => !lifecycle.includes(s)).sort(),
  ].map((s) => ({
    label: s.replace(/_/g, " "),
    display: String(byStatus.get(s) ?? 0),
    value: byStatus.get(s) ?? 0,
    tone: s === "blocked" ? "warn" : s === "overdue" ? "danger" : "accent",
  }));

  const tiles = [
    { k: "Open tasks", v: open.length },
    { k: "In progress", v: inProgress },
    { k: "Blocked", v: blocked, danger: blocked > 0 },
    { k: "Exceptions", v: exceptions.length, danger: exceptions.some((e) => e.severity === "critical") },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Operations"
        title="Delivery"
        lede="Fulfilment, tasks, projects and delivery. Everything below is a count of task rows in this company — nothing is estimated."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/operations/projects">Projects</Link>
            <Link className="btn ghost sm" href="/app/operations/tasks">All work</Link>
          </>
        }
      />

      <Section title="Position" />
      <div className="grid cols-4">
        <Link href="/app/operations/tasks" className="card stat">
          <div className="k">Open tasks</div>
          <div className="v">{fmtNumber(open.length)}</div>
          <div className="d">Not completed or cancelled</div>
        </Link>
        <Link href="/app/operations/tasks" className="card stat">
          <div className="k">In progress</div>
          <div className="v">{fmtNumber(inProgress)}</div>
          <div className="d">Someone is working on these</div>
        </Link>
        <Link href="/app/operations/tasks" className="card stat">
          <div className="k">Blocked</div>
          <div className="v">{fmtNumber(blocked)}</div>
          <div className="d">
            {blocked > 0 ? (
              <Signal kind="blocked">Waiting on someone or something</Signal>
            ) : (
              <Signal kind="ok">Nothing blocked</Signal>
            )}
          </div>
        </Link>
        <div className="card stat">
          <div className="k">Exceptions</div>
          <div className="v">{fmtNumber(exceptions.length)}</div>
          <div className="d">
            {exceptions.some((e) => e.severity === "critical") ? (
              <Signal kind="critical">At least one is critical</Signal>
            ) : exceptions.length > 0 ? (
              <Signal kind="warn">Review when convenient</Signal>
            ) : (
              <Signal kind="ok">Nothing flagged</Signal>
            )}
          </div>
        </div>
      </div>

      <Section title="Needs attention" meta={`${exceptions.length} flagged`} />
      {exceptions.length === 0 ? (
        <StateNote kind="empty" title="Nothing flagged">
          No task exception was detected across {fmtNumber(tasks.length)} task row(s) read for this
          company.
        </StateNote>
      ) : (
        <div className="field-matters">
          {exceptions.slice(0, 12).map((e, i) => (
            <Matter
              key={`${e.type}-${i}`}
              kind={e.type.replace(/_/g, " ")}
              kindIcon={
                e.severity === "critical" ? "alert-triangle" : e.severity === "warn" ? "alert-circle" : "info"
              }
              band={e.severity === "critical" ? "critical" : e.severity === "warn" ? "high" : "normal"}
              title={e.message}
              href={e.taskId ? `/app/operations/tasks/${e.taskId}` : undefined}
              footer={
                <>
                  <Signal
                    kind={e.severity === "critical" ? "critical" : e.severity === "warn" ? "warn" : "info"}
                  >
                    {e.severity === "critical" ? "Act now" : e.severity === "warn" ? "Decide today" : "Watch"}
                  </Signal>
                  <Badge variant={e.severity === "critical" ? "danger" : e.severity === "warn" ? "warn" : "info"}>
                    {e.type.replace(/_/g, " ")}
                  </Badge>
                </>
              }
            />
          ))}
        </div>
      )}

      {statusData.length > 0 && (
        <>
          <Section title="Work by state" meta="clear the amber and red bars first — they stall delivery" />
          <div className="card">
            <BarChart data={statusData} valueOnAll />
          </div>
        </>
      )}

      <Section title="The rest of Operations" />
      <div className="grid cols-3">
        {[
          { href: "/app/operations/tasks", label: "Work", icon: "list-todo", note: "Every task, arranged by what decides the next action" },
          { href: "/app/operations/projects", label: "Projects", icon: "git-branch", note: "The portfolio, ranked by value, risk and capacity" },
          { href: "/app/hr/capacity", label: "Capacity", icon: "gauge", note: "Who is carrying what" },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="node-card">
            <span className="node-card-ico" aria-hidden="true">
              <Icon name={item.icon} size={17} strokeWidth={1.6} />
            </span>
            <span className="node-card-text">
              <span className="node-card-title">{item.label}</span>
              <span className="node-card-note">{item.note}</span>
            </span>
            <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </div>
  );
}
