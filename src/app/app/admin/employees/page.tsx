import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { getDepartment } from "@/lib/departments";
import { Icon } from "@/components/Icon";
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
  const { data } = await supabaseAdmin()
    .from("profiles")
    .select("id, username, full_name, department, is_admin, is_active, created_at")
    .eq("company_id", admin.companyId)
    .order("created_at", { ascending: false });

  const rows = (data ?? []) as Row[];

  return (
    <div className="stack gap-3">
      <div>
        <h1>Employees</h1>
        <p className="muted mt-1">Create accounts and assign each person to a department.</p>
      </div>

      <div className="card">
        <div className="card-title">Add an employee</div>
        <p className="card-sub">They sign in with the username and password you set here.</p>
        <div className="mt-3">
          <CreateEmployeeForm />
        </div>
      </div>

      <div className="card">
        <div className="card-title">All employees ({rows.length})</div>
        {rows.length === 0 ? (
          <div className="empty">No employees yet. Add your first above.</div>
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Department</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const dept = getDepartment(r.department);
                  return (
                    <tr key={r.id}>
                      <td>
                        <div style={{ fontWeight: 700 }}>{r.full_name || r.username}</div>
                        <div className="small dim mono">@{r.username}</div>
                      </td>
                      <td>
                        <span className="badge">
                          {dept && <Icon name={dept.icon} size={13} />} {dept?.label ?? r.department}
                        </span>
                        {r.is_admin && <span className="badge accent" style={{ marginLeft: 6 }}>Admin</span>}
                      </td>
                      <td>
                        {r.is_active ? (
                          <span className="badge ok">Active</span>
                        ) : (
                          <span className="badge danger">Disabled</span>
                        )}
                      </td>
                      <td>
                        <div className="row gap-1 wrap">
                          <form action={setEmployeeActive}>
                            <input type="hidden" name="user_id" value={r.id} />
                            <input type="hidden" name="active" value={(!r.is_active).toString()} />
                            <button className="btn ghost sm" type="submit">
                              {r.is_active ? "Disable" : "Enable"}
                            </button>
                          </form>
                          <form action={setEmployeePassword} className="row gap-1">
                            <input type="hidden" name="user_id" value={r.id} />
                            <input
                              name="password"
                              className="input"
                              style={{ width: 150, padding: "6px 10px" }}
                              placeholder="new password"
                            />
                            <button className="btn ghost sm" type="submit">Reset</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
