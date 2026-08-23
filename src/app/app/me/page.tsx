/**
 * "My Work" — a personal workspace for any signed-in employee (§10.2). Shows the
 * tasks they created that are still open and the price confirmations routed to their
 * department. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { scorePriority } from "@/management/ai-manager/priority";
import { requestLeave } from "@/app/app/hr/staff/actions";
import { submitExpense } from "@/app/app/finance/expenses/actions";
import { Card, CardHeader, CardBody, Button, Badge, EmptyState, FormField } from "@/components/ui";
import { STATUS_VARIANTS } from "@/components/ui/Badge";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata = { title: "My Work — Singha Central" };

async function safe<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

const TERMINAL = new Set(["completed", "cancelled"]);

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

  return (
    <div className="stack gap-3">
      <div>
        <h1>My Work</h1>
        <p className="muted mt-1">Hi {profile.fullName ?? profile.username} — here&apos;s what&apos;s on you.</p>
      </div>

      <Card>
        <CardHeader title={`My open tasks (${myTasks.length})`} />
        {myTasks.length === 0 ? (
          <EmptyState
            title="No open tasks"
            description="You haven't created any open tasks."
            action={{ label: "Create one →", href: "/app/operations/tasks" }}
          />
        ) : (
          <div className="stack gap-1">
            {myTasks.map((t) => (
              <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{t.title}</span>
                <span className="row gap-1">
                  {t.due_date && <span className="small dim">{fmtDate(t.due_date)}</span>}
                  <Badge variant={STATUS_VARIANTS[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={`Assigned to me (${assignedToMe.length})`} />
        {assignedToMe.length === 0 ? (
          <EmptyState title="Nothing assigned" description="No tasks are assigned to you right now." />
        ) : (
          <div className="stack gap-1">
            {assignedToMe.map((t) => (
              <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{t.title}</span>
                <Badge variant={STATUS_VARIANTS[t.status] ?? "default"}>{t.status.replace(/_/g, " ")}</Badge>
              </Link>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Submit an expense" />
        <CardBody>
          <form action={submitExpense} className="row gap-1 wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 130px", minWidth: 120 }}>
              <FormField id="expense-amount" label="Amount" name="amount" inputMode="decimal" placeholder="0.00" required />
            </div>
            <div style={{ flex: "3 1 200px", minWidth: 200 }}>
              <FormField id="expense-purpose" label="Purpose" name="purpose" placeholder="What was it for?" required />
            </div>
            <Button variant="ghost" size="sm" type="submit">Submit</Button>
          </form>
        </CardBody>
        <p className="card-sub mt-2">Finance reviews and reimburses approved claims.</p>
      </Card>

      <Card>
        <CardHeader title="My leave" />
        <CardBody>
          <form action={requestLeave} className="row gap-1 wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ flex: "1 1 150px", minWidth: 140 }}>
              <FormField id="leave-start" label="From" name="start_date" type="date" required />
            </div>
            <div style={{ flex: "1 1 150px", minWidth: 140 }}>
              <FormField id="leave-end" label="To" name="end_date" type="date" required />
            </div>
            <div style={{ flex: "2 1 200px", minWidth: 200 }}>
              <FormField id="leave-reason" label="Reason" name="reason" placeholder="Reason" />
            </div>
            <Button variant="ghost" size="sm" type="submit">Request leave</Button>
          </form>
          {(myLeave ?? []).length === 0 ? (
            <EmptyState title="No leave requests" description="Your leave requests will appear here." className="mt-3" />
          ) : (
            <div className="stack gap-1 mt-3">
              {(myLeave ?? []).map((l: any) => (
                <div key={l.id} className="row between" style={{ padding: "6px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                  <span className="small">{fmtDate(l.start_date)} → {fmtDate(l.end_date)} <span className="dim">({fmtNumber(l.days)}d)</span></span>
                  <Badge variant={STATUS_VARIANTS[l.status] ?? "default"}>{l.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`Price confirmations for ${profile.department} (${priceConfs.length})`} />
        {priceConfs.length === 0 ? (
          <EmptyState title="Nothing awaiting your department" description="No open price confirmations need your department's input." />
        ) : (
          <div className="stack gap-1">
            {priceConfs.map((r) => (
              <div key={r.id} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{r.description} <span className="dim small">×{fmtNumber(r.quantity)}</span></span>
                <Badge variant="info">open</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
