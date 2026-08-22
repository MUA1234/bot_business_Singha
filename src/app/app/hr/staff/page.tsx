/**
 * HR → Staff (§7.1). Company-scoped employee directory with department, title and
 * skills. Read-only list; click through to a record. Graceful pre-migration.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { getDepartment } from "@/lib/departments";

export const metadata = { title: "Staff — Singha Central" };

export default async function StaffPage() {
  const p = await requireDepartment("hr");

  let rows: any[] = [];
  try {
    const { data } = await supabaseReadClient()
      .from("profiles")
      .select("id, username, full_name, department, job_title, skills, is_active")
      .eq("company_id", p.companyId)
      .order("full_name", { nullsFirst: false })
      .limit(500);
    rows = data ?? [];
  } catch {
    rows = [];
  }

  return (
    <div className="stack gap-3">
      <div>
        <h1>Staff</h1>
        <p className="muted mt-1">Everyone in your company — roles, titles and skills.</p>
      </div>

      <div className="card">
        {rows.length === 0 ? (
          <div className="empty">No staff records.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Name</th><th>Department</th><th>Title</th><th>Skills</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const dept = getDepartment(r.department);
                  return (
                    <tr key={r.id}>
                      <td><div style={{ fontWeight: 600 }}>{r.full_name || r.username}</div><div className="small dim mono">@{r.username}</div></td>
                      <td><span className="badge">{dept?.label ?? r.department}</span></td>
                      <td className="dim small">{r.job_title ?? "—"}</td>
                      <td className="small">{(r.skills ?? []).slice(0, 3).join(", ") || "—"}</td>
                      <td>{r.is_active ? <span className="badge ok">active</span> : <span className="badge">disabled</span>}</td>
                      <td><Link className="btn ghost sm" href={`/app/hr/staff/${r.id}`}>Open</Link></td>
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
