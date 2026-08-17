/**
 * HR employee record (§7.1): contact/title/skills editing, leave requests with
 * approve/reject, and remaining entitlement (pure leave engine). Company-scoped +
 * audited; graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getDepartment } from "@/lib/departments";
import { remainingLeave, type DateRange } from "@/modules/workforce/leave";
import { updateEmployeeDetails, requestLeave, decideLeave } from "../actions";

export const metadata = { title: "Employee — Singha Central" };

export default async function EmployeeRecord({ params }: { params: { id: string } }) {
  const p = await requireDepartment("hr");
  const db = supabaseAdmin();

  const { data: emp } = await db
    .from("profiles")
    .select("id, username, full_name, department, job_title, phone, start_date, skills, annual_leave_days, is_active")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!emp) notFound();

  const { data: leave } = await db
    .from("leave_requests")
    .select("id, start_date, end_date, days, reason, status")
    .eq("profile_id", emp.id)
    .eq("company_id", p.companyId)
    .order("start_date", { ascending: false });

  const approved: DateRange[] = (leave ?? []).filter((l: any) => l.status === "approved").map((l: any) => ({ start: l.start_date, end: l.end_date }));
  const remaining = remainingLeave(emp.annual_leave_days ?? 21, approved);
  const dept = getDepartment(emp.department);

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{emp.full_name || emp.username}</h1>
          <p className="muted mt-1"><span className="badge">{dept?.label ?? emp.department}</span> {emp.job_title ? `· ${emp.job_title}` : ""} · <span className="mono small">@{emp.username}</span></p>
        </div>
        <Link className="btn ghost sm" href="/app/hr/staff">← Staff</Link>
      </div>

      <div className="grid cols-3">
        <div className="card stat"><div className="k">Leave entitlement</div><div className="v" style={{ fontSize: "1.5rem" }}>{emp.annual_leave_days ?? 21}d</div></div>
        <div className="card stat"><div className="k">Remaining</div><div className="v" style={{ fontSize: "1.5rem", color: remaining < 0 ? "var(--danger)" : "var(--ok)" }}>{remaining}d</div></div>
        <div className="card stat"><div className="k">Skills</div><div className="v" style={{ fontSize: "1.5rem" }}>{(emp.skills ?? []).length}</div></div>
      </div>

      <div className="card">
        <div className="card-title">Details</div>
        <form action={updateEmployeeDetails} className="stack gap-2 mt-2" style={{ maxWidth: 620 }}>
          <input type="hidden" name="profile_id" value={emp.id} />
          <div className="row gap-1 wrap">
            <input name="job_title" className="input" style={{ flex: 1, minWidth: 150 }} placeholder="Job title" defaultValue={emp.job_title ?? ""} />
            <input name="phone" className="input" style={{ width: 160 }} placeholder="Phone" defaultValue={emp.phone ?? ""} />
            <label className="small dim">Start <input name="start_date" type="date" className="input" style={{ width: 150 }} defaultValue={emp.start_date ?? ""} /></label>
          </div>
          <input name="skills" className="input" placeholder="Skills (comma separated)" defaultValue={(emp.skills ?? []).join(", ")} />
          <button className="btn" type="submit">Save details</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Leave</div>
        <form action={requestLeave} className="row gap-1 wrap mt-2">
          <input type="hidden" name="profile_id" value={emp.id} />
          <label className="small dim">From <input name="start_date" type="date" className="input" style={{ width: 150 }} required /></label>
          <label className="small dim">To <input name="end_date" type="date" className="input" style={{ width: 150 }} required /></label>
          <input name="reason" className="input" style={{ flex: 1, minWidth: 140 }} placeholder="Reason" />
          <button className="btn ghost sm" type="submit">Request</button>
        </form>
        <div className="table-wrap mt-3">
          <table className="data">
            <thead><tr><th>Dates</th><th className="num">Days</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {(leave ?? []).length === 0 && <tr><td colSpan={5}><div className="empty">No leave requests.</div></td></tr>}
              {(leave ?? []).map((l: any) => (
                <tr key={l.id}>
                  <td className="dim small">{l.start_date} → {l.end_date}</td>
                  <td className="num">{Number(l.days)}</td>
                  <td>{l.reason ?? "—"}</td>
                  <td><span className={`badge ${l.status === "approved" ? "ok" : l.status === "rejected" ? "danger" : "warn"}`}>{l.status}</span></td>
                  <td>
                    {l.status === "pending" && (
                      <div className="row gap-1">
                        <form action={decideLeave}><input type="hidden" name="request_id" value={l.id} /><input type="hidden" name="decision" value="approved" /><button className="btn ghost sm" type="submit">Approve</button></form>
                        <form action={decideLeave}><input type="hidden" name="request_id" value={l.id} /><input type="hidden" name="decision" value="rejected" /><button className="btn ghost sm danger" type="submit">Reject</button></form>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
