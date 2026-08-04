import { requireAdmin } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";
import { DEPARTMENTS } from "@/lib/departments";

export const metadata = { title: "Departments — Singha Admin" };

export default async function DepartmentsPage() {
  const admin = await requireAdmin();
  const db = supabaseAdmin();

  const { data: cat } = await db.from("departments_catalog").select("key, label, description, is_active");
  const { data: profiles } = await db
    .from("profiles")
    .select("department")
    .eq("company_id", admin.companyId);

  const counts = new Map<string, number>();
  for (const p of profiles ?? []) counts.set(p.department, (counts.get(p.department) ?? 0) + 1);
  const active = new Map((cat ?? []).map((c: any) => [c.key, c.is_active]));

  return (
    <div className="stack gap-3">
      <div>
        <h1>Departments</h1>
        <p className="muted mt-1">
          Each department has its own login-gated dashboard. Assign employees from the Employees page.
        </p>
      </div>
      <div className="grid cols-3">
        {DEPARTMENTS.map((d) => (
          <div key={d.key} className="card">
            <div className="row between">
              <div className="card-title">
                {d.icon} {d.label}
              </div>
              {active.get(d.key) === false ? (
                <span className="badge danger">Off</span>
              ) : (
                <span className="badge ok">On</span>
              )}
            </div>
            <p className="card-sub mt-1">{d.description}</p>
            <div className="mt-2">
              <span className="badge">{counts.get(d.key) ?? 0} staff</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
