/**
 * Marketing → Audiences (§9). Company-scoped create + list, with a live size derived
 * from customers / leads. Audited, graceful.
 */
import { requireDepartment } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";

import { supabaseReadClient } from "@/lib/supabase/read";
import { createAudience } from "./actions";

export const metadata = { title: "Audiences — Singha Central" };

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try {
    return (await run()).count ?? 0;
  } catch {
    return 0;
  }
}

export default async function AudiencesPage() {
  const p = await requireDepartment("marketing");
  const db = supabaseReadClient();

  let rows: any[] = [];
  try {
    rows = (await db.from("audiences").select("id, name, source, created_at").eq("company_id", p.companyId).order("created_at", { ascending: false }).limit(200)).data ?? [];
  } catch {
    rows = [];
  }
  const [customerCount, leadCount] = await Promise.all([
    count(() => db.from("customers").select("id", { count: "exact", head: true }).eq("company_id", p.companyId) as any),
    count(() => db.from("leads").select("id", { count: "exact", head: true }).eq("company_id", p.companyId).not("stage", "in", "(won,lost)") as any),
  ]);
  const sizeFor = (source: string) => (source === "customers" ? customerCount : source === "leads" ? leadCount : 0);

  return (
    <div className="stack gap-3">
      <div>
        <h1>Audiences</h1>
        <p className="muted mt-1">Segments to target — sized from your customers and active leads.</p>
      </div>

      <div className="grid cols-2">
        <div className="card stat"><div className="k">Customers</div><div className="v" style={{ fontSize: "1.5rem" }}>{customerCount}</div></div>
        <div className="card stat"><div className="k">Active leads</div><div className="v" style={{ fontSize: "1.5rem" }}>{leadCount}</div></div>
      </div>

      <div className="card">
        <div className="card-title">New audience</div>
        <form action={createAudience} className="row gap-1 wrap mt-2">
          <input name="name" className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Audience name" required />
          <select name="source" className="select" style={{ width: 150 }} defaultValue="customers">
            <option value="customers">All customers</option>
            <option value="leads">Active leads</option>
            <option value="manual">Manual</option>
          </select>
          <button className="btn" type="submit">Create</button>
        </form>
      </div>

      <div className="card">
        <div className="card-title">Audiences ({rows.length})</div>
        {rows.length === 0 ? (
          <EmptyState title="No audiences yet." icon="users" />
        ) : (
          <div className="table-wrap mt-3">
            <table className="data">
              <thead><tr><th>Name</th><th>Source</th><th className="num">Size</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td style={{ fontWeight: 600 }}>{r.name}</td>
                    <td><span className="badge">{r.source}</span></td>
                    <td className="num">{sizeFor(r.source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
