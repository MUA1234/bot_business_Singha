import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { getDepartment } from "@/lib/departments";
import { fmtDate } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { Button } from "@/components/ui/Button";
import { CreateEmployeeForm } from "./CreateEmployeeForm";
import { setEmployeeActive, setEmployeePassword } from "./actions";

export const metadata = { title: "Employees — Singha Central" };

interface Row {
  id: string;
  username: string;
  full_name: string | null;
  department: string;
  is_admin: boolean;
  is_active: boolean;
  created_at: string;
}

export default async function EmployeesPage() {
  const admin = await requireAdmin();
  const { data } = await supabaseReadClient()
    .from("profiles")
    .select("id, username, full_name, department, is_admin, is_active, created_at")
    .eq("company_id", admin.companyId)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as Row[];

  const columns: DataTableColumn<Row>[] = [
    {
      key: "user",
      header: "User",
      render: (r) => (
        <div>
          <div style={{ fontWeight: 700 }}>{r.full_name || r.username}</div>
          <div className="small dim mono">@{r.username}</div>
        </div>
      ),
    },
    {
      key: "department",
      header: "Department",
      render: (r) => {
        const dept = getDepartment(r.department);
        return (
          <div className="row gap-1 wrap">
            <Badge icon={dept?.icon}>
              {dept?.label ?? r.department}
            </Badge>
            {r.is_admin && <Badge variant="accent">Admin</Badge>}
          </div>
        );
      },
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <StatusBadge status={r.is_active ? "Active" : "Disabled"} />
      ),
    },
    {
      key: "joined",
      header: "Joined",
      render: (r) => <span className="small dim">{fmtDate(r.created_at)}</span>,
    },
    {
      key: "actions",
      header: "Actions",
      render: (r) => (
        <div className="row gap-1 wrap">
          <form action={setEmployeeActive}>
            <input type="hidden" name="user_id" value={r.id} />
            <input type="hidden" name="active" value={(!r.is_active).toString()} />
            <Button variant="ghost" size="sm" type="submit" aria-label={r.is_active ? `Disable ${r.username}` : `Enable ${r.username}`}>
              {r.is_active ? "Disable" : "Enable"}
            </Button>
          </form>
          <form action={setEmployeePassword} className="row gap-1">
            <input type="hidden" name="user_id" value={r.id} />
            <input
              name="password"
              className="input"
              style={{ minWidth: 120, maxWidth: 160, padding: "6px 10px" }}
              placeholder="new password"
              aria-label={`New password for ${r.username}`}
            />
            <Button variant="ghost" size="sm" type="submit" aria-label={`Reset password for ${r.username}`}>
              Reset
            </Button>
          </form>
        </div>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Employees</h1>
        <p className="muted mt-1">Create accounts and assign each person to a department.</p>
      </div>

      <Card>
        <CardHeader title="Add an employee" subtitle="They sign in with the username and password you set here." />
        <CardBody>
          <CreateEmployeeForm />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={`All employees (${rows.length})`} />
        <CardBody padding="sm">
          {rows.length === 0 ? (
            <EmptyState title="No employees yet" description="Add your first employee above." icon="users" />
          ) : (
            <DataTable
              columns={columns}
              rows={rows}
              keyExtractor={(r) => r.id}
              caption="Employee accounts"
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
