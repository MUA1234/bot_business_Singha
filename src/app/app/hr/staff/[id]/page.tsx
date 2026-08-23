/**
 * HR employee record (§7.1): contact/title/skills editing, leave requests with
 * approve/reject, and remaining entitlement (pure leave engine). Company-scoped +
 * audited; graceful.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { getDepartment } from "@/lib/departments";
import { remainingLeave, type DateRange } from "@/modules/workforce/leave";
import { updateEmployeeDetails, requestLeave, decideLeave } from "../actions";
import { Card, CardHeader, CardBody, Button, Badge, StatusBadge, DataTable, type DataTableColumn, FormField } from "@/components/ui";
import { fmtDate, fmtNumber } from "@/lib/format";

export const metadata = { title: "Employee — Singha Central" };

interface LeaveItem {
  id: string;
  start_date: string;
  end_date: string;
  days: number;
  reason: string | null;
  status: string;
}

export default async function EmployeeRecord({ params }: { params: { id: string } }) {
  const p = await requireDepartment("hr");
  const db = supabaseReadClient();

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

  const leaveRows: LeaveItem[] = leave ?? [];
  const approved: DateRange[] = leaveRows.filter((l) => l.status === "approved").map((l) => ({ start: l.start_date, end: l.end_date }));
  const remaining = remainingLeave(emp.annual_leave_days ?? 21, approved);
  const dept = getDepartment(emp.department);

  const leaveColumns: DataTableColumn<LeaveItem>[] = [
    {
      key: "dates",
      header: "Dates",
      render: (l) => <span className="dim small">{fmtDate(l.start_date)} → {fmtDate(l.end_date)}</span>,
    },
    { key: "days", header: "Days", align: "right", render: (l) => fmtNumber(l.days) },
    { key: "reason", header: "Reason", render: (l) => l.reason ?? "—" },
    { key: "status", header: "Status", render: (l) => <StatusBadge status={l.status} /> },
    {
      key: "actions",
      header: "",
      render: (l) =>
        l.status === "pending" ? (
          <div className="row gap-1">
            <form action={decideLeave}>
              <input type="hidden" name="request_id" value={l.id} />
              <input type="hidden" name="decision" value="approved" />
              <Button type="submit" variant="ghost" size="sm">Approve</Button>
            </form>
            <form action={decideLeave}>
              <input type="hidden" name="request_id" value={l.id} />
              <input type="hidden" name="decision" value="rejected" />
              <Button type="submit" variant="danger" size="sm">Reject</Button>
            </form>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{emp.full_name || emp.username}</h1>
          <p className="muted mt-1">
            <Badge>{dept?.label ?? emp.department}</Badge>
            {" "}
            {emp.job_title ? `· ${emp.job_title}` : ""} · <span className="mono small">@{emp.username}</span>
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/hr/staff">← Staff</Link>
      </div>

      <div className="grid cols-3">
        <Card className="stat">
          <div className="k">Leave entitlement</div>
          <div className="v" style={{ fontSize: "1.5rem" }}>{fmtNumber(emp.annual_leave_days ?? 21)}d</div>
        </Card>
        <Card className="stat">
          <div className="k">Remaining</div>
          <div className="v" style={{ fontSize: "1.5rem", color: remaining < 0 ? "var(--danger)" : "var(--ok)" }}>{fmtNumber(remaining)}d</div>
        </Card>
        <Card className="stat">
          <div className="k">Skills</div>
          <div className="v" style={{ fontSize: "1.5rem" }}>{fmtNumber((emp.skills ?? []).length)}</div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Details" />
        <CardBody>
          <form action={updateEmployeeDetails} className="stack gap-2" style={{ maxWidth: 620 }}>
            <input type="hidden" name="profile_id" value={emp.id} />
            <div className="grid cols-2" style={{ gap: 16 }}>
              <FormField label="Job title" name="job_title" placeholder="Job title" defaultValue={emp.job_title ?? ""} />
              <FormField label="Phone" name="phone" placeholder="Phone" defaultValue={emp.phone ?? ""} />
            </div>
            <FormField label="Start date" name="start_date" type="date" defaultValue={emp.start_date ?? ""} />
            <FormField label="Skills" name="skills" placeholder="Skills (comma separated)" defaultValue={(emp.skills ?? []).join(", ")} />
            <div>
              <Button type="submit">Save details</Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Leave" />
        <CardBody>
          <form action={requestLeave} className="row gap-2 wrap">
            <input type="hidden" name="profile_id" value={emp.id} />
            <div style={{ flex: 1, minWidth: 150 }}>
              <FormField label="From" name="start_date" type="date" required />
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <FormField label="To" name="end_date" type="date" required />
            </div>
            <div style={{ flex: 2, minWidth: 180 }}>
              <FormField label="Reason" name="reason" placeholder="Reason" />
            </div>
            <div style={{ display: "flex", alignItems: "flex-end" }}>
              <Button type="submit" variant="ghost" size="sm">Request</Button>
            </div>
          </form>
          <div className="mt-3">
            <DataTable
              columns={leaveColumns}
              rows={leaveRows}
              keyExtractor={(l) => l.id}
              emptyTitle="No leave requests"
              emptyDescription="Submit a request using the form above."
            />
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
