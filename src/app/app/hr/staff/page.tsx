/**
 * HR → Staff (§7.1). Company-scoped employee directory with department, title and
 * skills. Read-only list; click through to a record. Graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { getDepartment } from "@/lib/departments";
import { Card, CardBody, Badge, StatusBadge, DataTable, type DataTableColumn } from "@/components/ui";

export const metadata = { title: "Staff — Singha Central" };

interface StaffRow {
  id: string;
  username: string;
  full_name: string | null;
  department: string | null;
  job_title: string | null;
  skills: string[] | null;
  is_active: boolean | null;
}

export default async function StaffPage() {
  const p = await requireDepartment("hr");

  let rows: StaffRow[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("profiles")
      .select("id, username, full_name, department, job_title, skills, is_active")
      .eq("company_id", p.companyId)
      .order("full_name", { nullsFirst: false })
      .limit(500);
    rows = (data as StaffRow[] | null) ?? [];
  } catch {
    rows = [];
  }

  const columns: DataTableColumn<StaffRow>[] = [
    {
      key: "name",
      header: "Name",
      render: (r) => (
        <div>
          <div style={{ fontWeight: 600 }}>{r.full_name || r.username}</div>
          <div className="small dim mono">@{r.username}</div>
        </div>
      ),
    },
    {
      key: "department",
      header: "Department",
      render: (r) => {
        const dept = getDepartment(r.department);
        return <Badge>{dept?.label ?? r.department ?? "—"}</Badge>;
      },
    },
    {
      key: "title",
      header: "Title",
      className: "dim small",
      render: (r) => r.job_title ?? "—",
    },
    {
      key: "skills",
      header: "Skills",
      className: "small",
      render: (r) => (r.skills ?? []).slice(0, 3).join(", ") || "—",
    },
    {
      key: "status",
      header: "Status",
      render: (r) => <StatusBadge status={r.is_active ? "active" : "disabled"} />,
    },
    {
      key: "open",
      header: "",
      align: "right",
      render: (r) => (
        <Link className="btn ghost sm" href={`/app/hr/staff/${r.id}`}>
          Open
        </Link>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Staff</h1>
        <p className="muted mt-1">Everyone in your company — roles, titles and skills.</p>
      </div>

      <Card>
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No staff records"
          />
        </CardBody>
      </Card>
    </div>
  );
}
