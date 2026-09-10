import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { DEPARTMENTS } from "@/lib/departments";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";

export const metadata = { title: "Departments — Singha Central" };

export default async function DepartmentsPage() {
  const admin = await requireAdmin();
  const db = supabaseReadClient();

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
      <div className="row between wrap">
        <div>
          <h1>Departments</h1>
          <p className="muted mt-1">
            Each department has its own login-gated dashboard. Assign employees from the Employees page.
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/admin/employees">
          Employees
        </Link>
      </div>

      <div className="dept-grid">
        {DEPARTMENTS.map((d) => (
          <div key={d.key} className="dept-chip">
            <div className="ic" aria-hidden="true">
              <Icon name={d.icon} size={20} />
            </div>
            <div className="grow">
              <div className="row between gap-1">
                <span className="t">{d.label}</span>
                {active.get(d.key) === false ? (
                  <Badge variant="danger">Off</Badge>
                ) : (
                  <Badge variant="ok">On</Badge>
                )}
              </div>
              <div className="s">{d.description}</div>
              <div className="mt-1">
                <Badge>{counts.get(d.key) ?? 0} staff</Badge>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
