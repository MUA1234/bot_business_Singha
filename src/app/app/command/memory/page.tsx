/**
 * MEM-001 — Organizational memory and evidence provenance.
 *
 * The command-centre memory surface retrieves prior cases, tasks and customer history
 * that the company already knows, scoped by company_id. Each item carries provenance:
 * the source entity type and id are shown, so a human (and a future analysis producer)
 * knows where the memory came from.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Memory — Singha Central" };

type MemoryCase = {
  id: string;
  case_type: string;
  outcome: string | null;
  created_at: string;
  source_event_id: string | null;
};

type MemoryTask = {
  id: string;
  title: string;
  status: string;
  due_date: string | null;
  created_at: string;
};

type MemoryCustomer = {
  id: string;
  name: string;
  created_at: string;
};

type MemoryIdentity = {
  id: string;
  actor_type: string;
  identifier: string;
  canonical_customer_id: string | null;
  canonical_supplier_id: string | null;
};

async function safeSelect<T>(
  run: () => PromiseLike<{ data: T[] | null; error: { message?: string } | null }>,
): Promise<T[]> {
  try {
    const { data, error } = await run();
    return error ? [] : (data ?? []);
  } catch {
    return [];
  }
}

export default async function MemoryPage() {
  const admin = await requireAdmin();
  const db = supabaseReadClient();

  const [cases, tasks, customers, identities] = await Promise.all([
    safeSelect<MemoryCase>(() =>
      db
        .from("management_cases")
        .select("id, case_type, outcome, created_at, source_event_id")
        .eq("company_id", admin.companyId)
        .order("created_at", { ascending: false })
        .limit(100)
    ),
    safeSelect<MemoryTask>(() =>
      db
        .from("tasks")
        .select("id, title, status, due_date, created_at")
        .eq("company_id", admin.companyId)
        .order("created_at", { ascending: false })
        .limit(100)
    ),
    safeSelect<MemoryCustomer>(() =>
      db
        .from("customers")
        .select("id, name, created_at")
        .eq("company_id", admin.companyId)
        .order("created_at", { ascending: false })
        .limit(100)
    ),
    safeSelect<MemoryIdentity>(() =>
      db
        .from("channel_identities")
        .select("id, actor_type, identifier, canonical_customer_id, canonical_supplier_id")
        .eq("company_id", admin.companyId)
        .limit(200)
    ),
  ]);

  const identitiesByCustomer = new Map<string, MemoryIdentity[]>();
  for (const idn of identities) {
    if (idn.canonical_customer_id) {
      const list = identitiesByCustomer.get(idn.canonical_customer_id) ?? [];
      list.push(idn);
      identitiesByCustomer.set(idn.canonical_customer_id, list);
    }
  }

  const SectionCard = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="card">
      <div className="card-title">{title}</div>
      {children}
    </div>
  );

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Organizational memory</h1>
          <p className="muted mt-1">Prior cases, tasks and customer history with provenance.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command">← Command Centre</Link>
      </div>

      <div className="grid cols-3">
        <SectionCard title={`Cases (${cases.length})`}>
          {cases.length === 0 ? (
            <div className="empty">No cases yet.</div>
          ) : (
            <div className="stack gap-1 mt-2">
              {cases.map((c) => (
                <div key={c.id} className="small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                  <div className="row between">
                    <span className="badge">{c.case_type}</span>
                    <span className="dim mono">case:{String(c.id).slice(0, 8)}</span>
                  </div>
                  <div className="mt-1">{c.outcome ?? "—"}</div>
                  <div className="dim small">{new Date(c.created_at).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title={`Tasks (${tasks.length})`}>
          {tasks.length === 0 ? (
            <div className="empty">No tasks yet.</div>
          ) : (
            <div className="stack gap-1 mt-2">
              {tasks.map((t) => (
                <div key={t.id} className="small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                  <div className="row between">
                    <Link href={`/app/operations/tasks/${t.id}`} className="link">{t.title}</Link>
                    <span className="badge">{t.status.replace(/_/g, " ")}</span>
                  </div>
                  <div className="dim small">task:{String(t.id).slice(0, 8)} · {t.due_date ? `due ${t.due_date}` : new Date(t.created_at).toLocaleDateString()}</div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title={`Customers (${customers.length})`}>
          {customers.length === 0 ? (
            <div className="empty">No customers yet.</div>
          ) : (
            <div className="stack gap-1 mt-2">
              {customers.map((c) => {
                const ids = identitiesByCustomer.get(c.id) ?? [];
                return (
                  <div key={c.id} className="small" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                    <div className="row between">
                      <Link href={`/app/sales/customers/${c.id}`} className="link">{c.name}</Link>
                      <span className="dim mono">customer:{String(c.id).slice(0, 8)}</span>
                    </div>
                    {ids.length > 0 && (
                      <div className="dim small mt-1">
                        {ids.map((i) => `${i.actor_type}:${i.identifier}`).join(" · ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </SectionCard>
      </div>
    </div>
  );
}
