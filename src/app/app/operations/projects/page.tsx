/**
 * Operations → Projects — PRJ-001 project registry with lifecycle states.
 *
 * Lists company-scoped projects and their lifecycle status. Tasks already reference
 * projects via project_id; this page gives projects a visible home.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Projects — Singha Central" };

interface Project {
  id: string;
  name: string;
  code: string | null;
  status: string;
  created_at: string;
}

export default async function ProjectsPage() {
  const p = await requireDepartment("operations");
  const db = supabaseReadClient();

  const { data: rows } = await db
    .from("projects")
    .select("id, name, code, status, created_at")
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: false })
    .limit(500);

  const projects: Project[] = (rows ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    status: r.status,
    created_at: r.created_at,
  }));

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Projects</h1>
          <p className="muted mt-1">Reusable project registry with lifecycle states.</p>
        </div>
        <Link className="btn ghost sm" href="/app/operations">← Operations</Link>
      </div>

      <div className="card">
        <div className="card-title">Project registry</div>
        {projects.length === 0 ? (
          <div className="empty mt-2">No projects yet.</div>
        ) : (
          <div className="table-wrap mt-2">
            <table className="data">
              <thead>
                <tr><th>Project</th><th>Code</th><th>Status</th><th>Created</th></tr>
              </thead>
              <tbody>
                {projects.map((proj) => {
                  const statusTone = proj.status === "active" ? "ok" : proj.status === "on_hold" ? "warn" : proj.status === "completed" ? "" : "";
                  return (
                    <tr key={proj.id}>
                      <td style={{ fontWeight: 600 }}>{proj.name}</td>
                      <td className="dim small mono">{proj.code ?? "—"}</td>
                      <td><span className={`badge ${statusTone}`}>{proj.status.replace(/_/g, " ")}</span></td>
                      <td className="dim small">{proj.created_at ? new Date(proj.created_at).toLocaleDateString() : "—"}</td>
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
