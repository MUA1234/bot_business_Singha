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
import { Card, CardHeader, CardBody, Badge, StatusBadge, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";

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

  const profiles = Array.from(byProfile.values());

  const leaveColumns: DataTableColumn<LeaveRow>[] = [
    {
      key: "person",
      header: "Person",
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.full_name ?? "—"}</div>
          {r.username && <div className="small dim mono">@{r.username}</div>}
        </div>
      ),
    },
    {
      key: "dates",
      header: "Dates",
      render: (r) => <span className="dim small mono">{fmtDate(r.start_date)} → {fmtDate(r.end_date)}</span>,
    },
    { key: "days", header: "Days", align: "right", render: (r) => fmtNumber(r.days) },
    { key: "reason", header: "Reason", render: (r) => <span className="dim small">{r.reason ?? "—"}</span> },
    { key: "status", header: "Status", render: (r) => <StatusBadge status={r.status} /> },
    {
      key: "decided",
      header: "Decided",
      render: (r) => <span className="dim small">{fmtDate(r.decided_at)}</span>,
    },
  ];

  const profileColumns: DataTableColumn<ProfileLeave>[] = [
    {
      key: "person",
      header: "Person",
      render: (profile) => (
        <div>
          <div style={{ fontWeight: 600 }}>{profile.full_name ?? "—"}</div>
          {profile.username && <div className="small dim mono">@{profile.username}</div>}
        </div>
      ),
    },
    { key: "entitlement", header: "Entitlement", align: "right", render: (profile) => fmtNumber(profile.annual_leave_days) },
    {
      key: "used",
      header: "Used",
      align: "right",
      render: (profile) => fmtNumber(usedLeaveDays(profile.approved)),
    },
    {
      key: "remaining",
      header: "Remaining",
      align: "right",
      render: (profile) => {
        const remaining = remainingLeave(profile.annual_leave_days, profile.approved);
        return <Badge variant={remaining < 0 ? "warn" : "ok"}>{fmtNumber(remaining)}</Badge>;
      },
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Leave</h1>
          <p className="muted mt-1">Leave requests and remaining entitlement per person.</p>
        </div>
        <Link className="btn ghost sm" href="/app/hr">← HR</Link>
      </div>

      <Card>
        <CardHeader title="Leave requests" />
        <CardBody>
          <DataTable
            columns={leaveColumns}
            rows={leave}
            keyExtractor={(r) => r.id}
            emptyTitle="No leave requests yet"
            emptyDescription="Leave requests will appear here once submitted."
          />
        </CardBody>
      </Card>

      {profiles.length > 0 && (
        <Card>
          <CardHeader title="Remaining leave" />
          <CardBody>
            <DataTable
              columns={profileColumns}
              rows={profiles}
              keyExtractor={(profile) => profile.profile_id}
            />
          </CardBody>
        </Card>
      )}
    </div>
  );
}
