/**
 * "My Work" — the personal staff cockpit (§10.2).
 *
 * The first question this screen answers is WHAT SHOULD I DO NEXT, before
 * anything else: the highest-priority open item assigned to or created by this
 * person, at the front of the field. Everything else — today, blocked, waiting
 * on my department, leave, expense capture — follows.
 *
 * Read-only for work, company-scoped, and graceful: a missing table degrades to
 * an empty section rather than a failed page. Priority ordering uses the same
 * deterministic `scorePriority` helper the Command Centre uses, so a person and
 * their manager see the same order.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { scorePriority } from "@/management/ai-manager/priority";
import { requestLeave } from "@/app/app/hr/staff/actions";
import { submitExpense } from "@/app/app/finance/expenses/actions";
import { Button, Badge, EmptyState, FormField } from "@/components/ui";
import { STATUS_VARIANTS } from "@/components/ui/Badge";
import { fmtDate, fmtNumber } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "My Work — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

const TERMINAL = new Set(["completed", "cancelled"]);

/** Whole days until a date; negative when it has passed. */
function daysUntil(due: string | null, now: Date): number | null {
  if (!due) return null;
  const t = Date.parse(`${due.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((t - start) / 86_400_000);
}

export default async function MyWorkPage() {
  const profile = await requireProfile();
  const db = supabaseReadClient();
  const now = new Date();

  const [tasks, assignedTasks, priceConfs, myLeave] = await Promise.all([
    safe<any>(() =>
      db.from("tasks")
        .select("id, title, status, due_date, priority")
        .eq("company_id", profile.companyId)
        .eq("created_by", profile.userId)
        .limit(200) as any,
    ),
    safe<any>(() =>
      db.from("tasks")
        .select("id, title, status, due_date, priority")
        .eq("company_id", profile.companyId)
        .eq("assigned_to", profile.userId)
        .limit(200) as any,
    ),
    safe<any>(() =>
      db.from("price_confirmations")
        .select("id, description, quantity, currency, status")
        .eq("company_id", profile.companyId)
        .eq("department", profile.department)
        .eq("status", "open")
        .limit(100) as any,
    ),
    safe<any>(() =>
      db.from("leave_requests")
        .select("id, start_date, end_date, days, status")
        .eq("company_id", profile.companyId)
        .eq("profile_id", profile.userId)
        .order("start_date", { ascending: false })
        .limit(20) as any,
    ),
  ]);

  const sortByUrgency = (list: any[]) =>
    list
      .filter((t) => !TERMINAL.has(t.status))
      .sort((a, b) => scorePriority({ status: b.status, dueDate: b.due_date, basePriority: b.priority }, now) - scorePriority({ status: a.status, dueDate: a.due_date, basePriority: a.priority }, now));
  const myTasks = sortByUrgency(tasks);
  const assignedToMe = sortByUrgency(assignedTasks);

  // The single next thing. Work ASSIGNED to this person outranks work they
  // merely raised — being accountable for it is what makes it theirs to do.
  const next = assignedToMe[0] ?? myTasks[0] ?? null;
  const nextDays = next ? daysUntil(next.due_date, now) : null;

  // Everything of mine that is late or blocked, from both lists, de-duplicated.
  const seen = new Set<string>();
  const pressing = [...assignedToMe, ...myTasks].filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    if (t.id === next?.id) return false;
    const d = daysUntil(t.due_date, now);
    return t.status === "blocked" || t.status === "overdue" || (d !== null && d <= 1);
  });

  const pendingLeave = (myLeave ?? []).filter((l: any) => l.status === "pending").length;

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="My work"
        title="What should I do next?"
        lede={`${profile.fullName ?? profile.username} — the order below is the same one your manager sees, computed from status and due date.`}
      />

      {/* ── THE NEXT THING ──────────────────────────────────────────────── */}
      {next ? (
        <div className="field-matters">
          <Matter
            kind="Do this next"
            kindIcon="compass"
            band={
              next.status === "blocked" || next.status === "overdue" || (nextDays !== null && nextDays < 0)
                ? "critical"
                : "high"
            }
            title={next.title}
            href={`/app/operations/tasks/${next.id}`}
            facts={[
              { k: "State", v: next.status.replace(/_/g, " ") },
              {
                k: "Due",
                v:
                  nextDays === null
                    ? ""
                    : nextDays < 0
                      ? `${Math.abs(nextDays)} day${Math.abs(nextDays) === 1 ? "" : "s"} late`
                      : nextDays === 0
                        ? "today"
                        : `in ${nextDays} day${nextDays === 1 ? "" : "s"}`,
                missing: nextDays === null,
              },
              { k: "Yours because", v: assignedToMe[0]?.id === next.id ? "assigned to you" : "you raised it" },
            ]}
            footer={
              next.status === "blocked" ? (
                <Signal kind="blocked">Blocked — say what you are waiting on</Signal>
              ) : (
                <Signal kind="warn">Highest priority open item</Signal>
              )
            }
          />
        </div>
      ) : (
        <StateNote kind="empty" title="Nothing is waiting on you">
          No open work is assigned to you and you have raised none. If that seems wrong, check with
          whoever assigns work in your department.
        </StateNote>
      )}

      {/* ── PRESSING ────────────────────────────────────────────────────── */}
      {pressing.length > 0 && (
        <>
          <Section title="Also pressing" meta="late, blocked or due within a day" />
          <div className="card">
            <div className="stack gap-1">
              {pressing.map((t) => {
                const d = daysUntil(t.due_date, now);
                return (
                  <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="node-card">
                    <span className="node-card-text">
                      <span className="node-card-title">{t.title}</span>
                      <span className="node-card-note">
                        {t.status.replace(/_/g, " ")}
                        {d !== null && (d < 0 ? ` · ${Math.abs(d)}d late` : d === 0 ? " · due today" : ` · due in ${d}d`)}
                      </span>
                    </span>
                    <Badge variant={STATUS_VARIANTS[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
                  </Link>
                );
              })}
            </div>
          </div>
        </>
      )}

      {/* ── ASSIGNED / RAISED ───────────────────────────────────────────── */}
      <Section title="Assigned to me" meta={`${assignedToMe.length} open`} />
      <div className="card">
        {assignedToMe.length === 0 ? (
          <EmptyState title="Nothing assigned" description="No tasks are assigned to you right now." />
        ) : (
          <div className="stack gap-1">
            {assignedToMe.map((t) => (
              <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="node-card">
                <span className="node-card-text">
                  <span className="node-card-title">{t.title}</span>
                  {t.due_date && <span className="node-card-note">Due {fmtDate(t.due_date)}</span>}
                </span>
                <Badge variant={STATUS_VARIANTS[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
              </Link>
            ))}
          </div>
        )}
      </div>

      <Section title="Work I raised" meta={`${myTasks.length} open`} />
      <div className="card">
        {myTasks.length === 0 ? (
          <EmptyState
            title="No open tasks"
            description="You haven't raised any open tasks."
            action={{ label: "Create one", href: "/app/operations/tasks" }}
          />
        ) : (
          <div className="stack gap-1">
            {myTasks.map((t) => (
              <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="node-card">
                <span className="node-card-text">
                  <span className="node-card-title">{t.title}</span>
                  {t.due_date && <span className="node-card-note">Due {fmtDate(t.due_date)}</span>}
                </span>
                <Badge variant={STATUS_VARIANTS[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* ── WAITING ON MY DEPARTMENT ────────────────────────────────────── */}
      <Section
        title={`Waiting on ${profile.department}`}
        meta={`${priceConfs.length} price confirmation${priceConfs.length === 1 ? "" : "s"}`}
      />
      <div className="card">
        {priceConfs.length === 0 ? (
          <EmptyState
            title="Nothing awaiting your department"
            description="No open price confirmations need your department's input."
          />
        ) : (
          <div className="stack gap-1">
            {priceConfs.map((r) => (
              <div key={r.id} className="node-card">
                <span className="node-card-text">
                  <span className="node-card-title">{r.description}</span>
                  <span className="node-card-note">Quantity {fmtNumber(r.quantity)}</span>
                </span>
                <Signal kind="warn">A customer is waiting</Signal>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── CAPTURE — the two things staff do on a phone ─────────────────── */}
      <Section title="Capture" meta="works on a phone" />
      <div className="grid cols-2">
        <div className="card">
          <div className="row gap-2" style={{ marginBottom: "var(--sp-3)" }}>
            <Icon name="receipt" size={17} className="dim" aria-hidden="true" />
            <strong>Submit an expense</strong>
          </div>
          <form action={submitExpense} className="stack gap-2">
            <FormField id="expense-amount" label="Amount" name="amount" inputMode="decimal" placeholder="0.00" required />
            <FormField id="expense-purpose" label="Purpose" name="purpose" placeholder="What was it for?" required />
            <Button variant="ghost" size="sm" type="submit">Submit claim</Button>
          </form>
          <p className="small dim mt-2">
            Finance reviews and reimburses approved claims. Submitting is not approval, and approval
            is not payment.
          </p>
        </div>

        <div className="card">
          <div className="row gap-2 between" style={{ marginBottom: "var(--sp-3)" }}>
            <span className="row gap-2">
              <Icon name="calendar-days" size={17} className="dim" aria-hidden="true" />
              <strong>My leave</strong>
            </span>
            {pendingLeave > 0 && <Signal kind="info">{pendingLeave} awaiting a decision</Signal>}
          </div>
          <form action={requestLeave} className="stack gap-2">
            <div className="grid cols-2">
              <FormField id="leave-start" label="From" name="start_date" type="date" required />
              <FormField id="leave-end" label="To" name="end_date" type="date" required />
            </div>
            <FormField id="leave-reason" label="Reason" name="reason" placeholder="Reason" />
            <Button variant="ghost" size="sm" type="submit">Request leave</Button>
          </form>
          {(myLeave ?? []).length === 0 ? (
            <p className="small dim mt-3">Your leave requests will appear here.</p>
          ) : (
            <div className="stack gap-1 mt-3">
              {(myLeave ?? []).map((l: any) => (
                <div key={l.id} className="row between" style={{ padding: "6px 0", borderBottom: "1px solid rgba(255,252,246,0.05)" }}>
                  <span className="small">
                    {fmtDate(l.start_date)} → {fmtDate(l.end_date)}{" "}
                    <span className="dim">({fmtNumber(l.days)}d)</span>
                  </span>
                  <Badge variant={STATUS_VARIANTS[l.status] ?? "default"}>{l.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
