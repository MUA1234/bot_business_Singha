/**
 * Leave — WRK-001 attendance and availability foundation.
 *
 * Lists company-scoped leave requests and shows remaining annual leave per person
 * using the pure leave calculation module. Scope is intentionally leave only:
 * attendance, travel and working-hours modelling remain future work.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { remainingLeave, usedLeaveDays } from "@/modules/workforce/leave";

export const metadata = { title: "Leave — Singha Central" };

interface LeaveRow {
  id: string;
  profile_id: string;
  full_name: string | null;
  username: string | null;
  start_date: string;
  end_date: string;
  days: number;
  reason: string | null;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
}

interface ProfileLeave {
  profile_id: string;
  full_name: string | null;
  username: string | null;
  annual_leave_days: number;
  approved: { start: string; end: string }[];
}

export default async function LeavePage() {
  const p = await requireDepartment("hr");
  const db = supabaseReadClient();

  const { data: rows } = await db
    .from("leave_requests")
    .select("id, profile_id, start_date, end_date, days, reason, status, decided_by, decided_at, profiles(full_name, username, annual_leave_days)")
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(500);

  const leave: LeaveRow[] = (rows ?? []).map((r: any) => {
    const profile = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
    return {
      id: r.id,
      profile_id: r.profile_id,
      full_name: profile?.full_name ?? null,
      username: profile?.username ?? null,
      start_date: r.start_date,
      end_date: r.end_date,
      days: r.days,
      reason: r.reason,
      status: r.status,
      decided_by: r.decided_by,
      decided_at: r.decided_at,
    };
  });

  const byProfile = new Map<string, ProfileLeave>();
  for (const r of leave) {
    const existing = byProfile.get(r.profile_id);
    const row = (rows ?? []).find((x: any) => x.profile_id === r.profile_id);
    const profile = Array.isArray(row?.profiles) ? row.profiles[0] : row?.profiles;
    const annual = profile?.annual_leave_days ?? 21;
    if (!existing) {
      byProfile.set(r.profile_id, {
        profile_id: r.profile_id,
        full_name: r.full_name,
        username: r.username,
        annual_leave_days: annual,
        approved: r.status === "approved" ? [{ start: r.start_date, end: r.end_date }] : [],
      });
    } else if (r.status === "approved") {
      existing.approved.push({ start: r.start_date, end: r.end_date });
    }
  }

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Leave</h1>
          <p className="muted mt-1">Leave requests and remaining entitlement per person.</p>
        </div>
        <Link className="btn ghost sm" href="/app/hr">← HR</Link>
      </div>

      <div className="card">
        <div className="card-title">Leave requests</div>
        {leave.length === 0 ? (
          <div className="empty mt-2">No leave requests yet.</div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="data">
              <thead>
                <tr><th>Person</th><th>Dates</th><th>Days</th><th>Reason</th><th>Status</th><th>Decided</th></tr>
              </thead>
              <tbody>
                {leave.map((r) => {
                  const profile = byProfile.get(r.profile_id);
                  const remaining = profile ? remainingLeave(profile.annual_leave_days, profile.approved) : null;
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{r.full_name ?? "—"}</div>
                        {r.username && <div className="small dim mono">@{r.username}</div>}
                      </td>
                      <td className="dim small mono">
                        {r.start_date} → {r.end_date}
                      </td>
                      <td>{r.days}</td>
                      <td className="dim small">{r.reason ?? "—"}</td>
                      <td><span className={`badge ${r.status === "pending" ? "warn" : r.status === "approved" ? "ok" : ""}`}>{r.status}</span></td>
                      <td className="dim small">
                        {r.decided_at ? new Date(r.decided_at).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {byProfile.size > 0 && (
        <div className="card">
          <div className="card-title">Remaining leave</div>
          <div className="table-wrap mt-2">
            <table className="data">
              <thead><tr><th>Person</th><th>Entitlement</th><th>Used</th><th>Remaining</th></tr></thead>
              <tbody>
                {Array.from(byProfile.values()).map((profile) => {
                  const used = usedLeaveDays(profile.approved);
                  const remaining = remainingLeave(profile.annual_leave_days, profile.approved);
                  return (
                    <tr key={profile.profile_id}>
                      <td>
                        <div style={{ fontWeight: 600 }}>{profile.full_name ?? "—"}</div>
                        {profile.username && <div className="small dim mono">@{profile.username}</div>}
                      </td>
                      <td>{profile.annual_leave_days}</td>
                      <td>{used}</td>
                      <td><span className={remaining < 0 ? "badge warn" : "badge ok"}>{remaining}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
