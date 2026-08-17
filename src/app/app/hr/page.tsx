/**
 * HR overview — live dashboard (§10). Staff, pending leave, and capacity status.
 * Company-scoped, graceful.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Human Resources — Singha Central" };

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try { return (await run()).count ?? 0; } catch { return 0; }
}
async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try { return (await run()).data ?? []; } catch { return []; }
}

export default async function HrHome() {
  const p = await requireDepartment("hr");
  const db = supabaseAdmin();

  const [staff, pendingLeave, caps] = await Promise.all([
    count(() => db.from("profiles").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("is_active", true) as any),
    count(() => db.from("leave_requests").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).eq("status", "pending") as any),
    rows<any>(() => db.from("capacity_snapshots").select("status, week_start").eq("company_id", p.companyId).order("week_start", { ascending: false }).limit(200) as any),
  ]);
  const latestWeek = caps[0]?.week_start;
  const thisWeek = caps.filter((c) => c.week_start === latestWeek);
  const overloaded = thisWeek.filter((c) => c.status === "overloaded").length;

  const tiles = [
    { k: "Active staff", v: staff, href: "/app/hr/staff" },
    { k: "Pending leave", v: pendingLeave, href: "/app/hr/staff", danger: pendingLeave > 0 },
    { k: "Overloaded", v: overloaded, href: "/app/hr/capacity", danger: overloaded > 0 },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div><h1>Human Resources</h1><p className="muted mt-1">Staff records, leave and capacity.</p></div>
        <Link className="btn sm" href="/app/hr/capacity">Capacity →</Link>
      </div>
      <div className="grid cols-3">
        {tiles.map((t) => (
          <Link key={t.k} href={t.href} className="card stat"><div className="k">{t.k}</div><div className="v" style={{ fontSize: "1.8rem", color: t.danger ? "var(--danger)" : undefined }}>{t.v}</div></Link>
        ))}
      </div>
    </div>
  );
}
