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
import { fmtDate } from "@/lib/format";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge, StatusBadge } from "@/components/ui/Badge";
import { EmptyState } from "@/components/ui/EmptyState";

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

  return (
    <div className="stack gap-3">
      <div className="row between wrap gap-2">
        <div>
          <h1>Organizational memory</h1>
          <p className="muted mt-1">Prior cases, tasks and customer history with provenance.</p>
        </div>
        <Link className="btn ghost sm" href="/app/command" aria-label="Back to Command Centre">← Command Centre</Link>
      </div>

      <div className="grid cols-3">
        <Card ariaLabel={`Cases (${cases.length})`}>
          <CardHeader title={`Cases (${cases.length})`} />
          <CardBody padding="sm">
            {cases.length === 0 ? (
              <EmptyState title="No cases yet" icon="clipboard" />
            ) : (
              <div className="stack gap-1">
                {cases.map((c) => (
                  <div key={c.id} className="small row-item" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                    <div className="row between">
                      <Badge>{c.case_type}</Badge>
                      <span className="dim mono">case:{String(c.id).slice(0, 8)}</span>
                    </div>
                    <div className="mt-1">{c.outcome ?? "—"}</div>
                    <div className="dim small">{fmtDate(c.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card ariaLabel={`Tasks (${tasks.length})`}>
          <CardHeader title={`Tasks (${tasks.length})`} />
          <CardBody padding="sm">
            {tasks.length === 0 ? (
              <EmptyState title="No tasks yet" icon="list-todo" />
            ) : (
              <div className="stack gap-1">
                {tasks.map((t) => (
                  <div key={t.id} className="small row-item" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
                    <div className="row between">
                      <Link href={`/app/operations/tasks/${t.id}`} className="link">{t.title}</Link>
                      <StatusBadge status={t.status.replace(/_/g, " ")} />
                    </div>
                    <div className="dim small">task:{String(t.id).slice(0, 8)} · {t.due_date ? `due ${fmtDate(t.due_date)}` : fmtDate(t.created_at)}</div>
                  </div>
                ))}
              </div>
            )}
          </CardBody>
        </Card>

        <Card ariaLabel={`Customers (${customers.length})`}>
          <CardHeader title={`Customers (${customers.length})`} />
          <CardBody padding="sm">
            {customers.length === 0 ? (
              <EmptyState title="No customers yet" icon="user-round" />
            ) : (
              <div className="stack gap-1">
                {customers.map((c) => {
                  const ids = identitiesByCustomer.get(c.id) ?? [];
                  return (
                    <div key={c.id} className="small row-item" style={{ borderBottom: "1px solid var(--panel-border)", padding: "6px 0" }}>
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
          </CardBody>
        </Card>
      </div>

    </div>
  );
}
