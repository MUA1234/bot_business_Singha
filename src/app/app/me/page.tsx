/**
 * "My Work" — a personal workspace for any signed-in employee (§10.2). Shows the
 * tasks they created that are still open and the price confirmations routed to their
 * department. Read-only, company-scoped, graceful.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { scorePriority } from "@/management/ai-manager/priority";
import { requestLeave } from "@/app/app/hr/staff/actions";
import { submitExpense } from "@/app/app/finance/expenses/actions";

export const metadata = { title: "My Work — Singha" };

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
  const db = supabaseAdmin();
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
        <p className="muted mt-1">Hi {profile.fullName ?? profile.username} — here's what's on you.</p>
      </div>

      <div className="card">
        <div className="card-title">My open tasks ({myTasks.length})</div>
        {myTasks.length === 0 ? (
          <div className="empty">No open tasks you created. <Link href="/app/operations/tasks">Create one →</Link></div>
        ) : (
          <div className="stack gap-1 mt-2">
            {myTasks.map((t) => (
              <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{t.title}</span>
                <span className="row gap-1">
                  {t.due_date && <span className="small dim">{t.due_date}</span>}
                  <span className="badge">{t.status.replace(/_/g, " ")}</span>
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Assigned to me ({assignedToMe.length})</div>
        {assignedToMe.length === 0 ? (
          <div className="empty">Nothing assigned to you.</div>
        ) : (
          <div className="stack gap-1 mt-2">
            {assignedToMe.map((t) => (
              <Link key={t.id} href={`/app/operations/tasks/${t.id}`} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{t.title}</span>
                <span className="badge">{t.status.replace(/_/g, " ")}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-title">Submit an expense</div>
        <form action={submitExpense} className="row gap-1 wrap mt-2">
          <input name="amount" className="input" style={{ width: 130 }} placeholder="Amount" inputMode="decimal" />
          <input name="purpose" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="What was it for?" />
          <button className="btn ghost sm" type="submit">Submit</button>
        </form>
        <p className="card-sub mt-2">Finance reviews and reimburses approved claims.</p>
      </div>

      <div className="card">
        <div className="card-title">My leave</div>
        <form action={requestLeave} className="row gap-1 wrap mt-2">
          <label className="small dim">From <input name="start_date" type="date" className="input" style={{ width: 150 }} required /></label>
          <label className="small dim">To <input name="end_date" type="date" className="input" style={{ width: 150 }} required /></label>
          <input name="reason" className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Reason" />
          <button className="btn ghost sm" type="submit">Request leave</button>
        </form>
        <div className="stack gap-1 mt-3">
          {(myLeave ?? []).length === 0 && <div className="empty">No leave requests.</div>}
          {(myLeave ?? []).map((l: any) => (
            <div key={l.id} className="row between" style={{ padding: "6px 4px", borderBottom: "1px solid var(--panel-border)" }}>
              <span className="small">{l.start_date} → {l.end_date} <span className="dim">({Number(l.days)}d)</span></span>
              <span className={`badge ${l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}`}>{l.status}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Price confirmations for {profile.department} ({priceConfs.length})</div>
        {priceConfs.length === 0 ? (
          <div className="empty">Nothing awaiting your department.</div>
        ) : (
          <div className="stack gap-1 mt-2">
            {priceConfs.map((r) => (
              <div key={r.id} className="row between" style={{ padding: "8px 4px", borderBottom: "1px solid var(--panel-border)" }}>
                <span>{r.description} <span className="dim small">×{Number(r.quantity)}</span></span>
                <span className="badge warn">open</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
