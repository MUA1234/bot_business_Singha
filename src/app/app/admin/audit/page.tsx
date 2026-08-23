/**
 * Admin → Audit Log (§13). The append-only trail of privileged and AI actions,
 * company-scoped. Read-only; supports a simple entity filter via ?entity=. Every
 * action here was recorded by a domain service — the ledger of who did what.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { describeAction } from "@/lib/audit-format";
import { Card, CardHeader, CardBody } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Audit Log — Singha Central" };

/** GOV-006 — entity types that record governance decisions and obligations. */
const GOVERNANCE_ENTITY_TYPES = [
  "management_directive",
  "approval_request",
  "policy_evaluation",
  "delegation",
  "authority_rule",
];

interface AuditRow {
  id: string;
  actor_type: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  created_at: string;
}

export default async function AuditPage({ searchParams }: { searchParams: { entity?: string; governance?: string } }) {
  const admin = await requireAdmin();
  const entity = (searchParams.entity ?? "").trim();
  const governance = searchParams.governance === "1" || searchParams.governance === "true";

  let rows: AuditRow[] = [];
  try {
    let q = supabaseReadClient().from("audit_events")
      .select("id, actor_type, action, entity_type, entity_id, created_at")
      .eq("company_id", admin.companyId)
      .order("created_at", { ascending: false })
      .limit(300);
    if (entity) q = q.eq("entity_type", entity);
    if (governance) q = q.in("entity_type", GOVERNANCE_ENTITY_TYPES);
    rows = ((await q).data ?? []) as AuditRow[];
  } catch {
    rows = [];
  }

  const entities = [...new Set(rows.map((r) => r.entity_type))].sort();
  const actorVariant = (t: string) => (t === "ai" ? "warn" : t === "system" ? "info" : "default");
  const isActiveChip = (chipEntity?: string) =>
    (!chipEntity && !entity && !governance) || (chipEntity === entity) || (chipEntity === "governance" && governance);

  const columns: DataTableColumn<AuditRow>[] = [
    { key: "when", header: "When", render: (r) => <span className="dim small">{fmtDateTime(r.created_at)}</span> },
    {
      key: "actor",
      header: "Actor",
      render: (r) => <Badge variant={actorVariant(r.actor_type)}>{r.actor_type}</Badge>,
    },
    { key: "action", header: "Action", render: (r) => describeAction(r.action) },
    {
      key: "entity",
      header: "Entity",
      render: (r) => (
        <span className="dim small mono">
          {r.entity_type}
          {r.entity_id ? ` · ${String(r.entity_id).slice(0, 8)}` : ""}
        </span>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between wrap">
        <div>
          <h1>Audit Log</h1>
          <p className="muted mt-1">Append-only record of privileged and AI actions.</p>
        </div>
        <div className="row gap-1 wrap">
          <a className="btn ghost sm" href="/api/exports/audit">Export CSV</a>
          <Link className="btn ghost sm" href="/app/admin">← Admin</Link>
        </div>
      </div>

      <div className="row gap-1 wrap small">
        <Link
          className={`btn ghost sm ${isActiveChip() ? "active" : ""}`}
          href="/app/admin/audit"
          aria-current={isActiveChip() ? "page" : undefined}
        >
          All
        </Link>
        <Link
          className={`btn ghost sm ${governance ? "active" : ""}`}
          href="/app/admin/audit?governance=1"
          aria-current={governance ? "page" : undefined}
        >
          Governance
        </Link>
        {entities.map((e) => (
          <Link
            key={e}
            className={`btn ghost sm ${entity === e ? "active" : ""}`}
            href={`/app/admin/audit?entity=${encodeURIComponent(e)}`}
            aria-current={entity === e ? "page" : undefined}
          >
            {e}
          </Link>
        ))}
      </div>

      <Card>
        <CardHeader title="Events" subtitle={`${rows.length} event${rows.length === 1 ? "" : "s"}`} />
        <CardBody>
          <DataTable
            columns={columns}
            rows={rows}
            keyExtractor={(r) => r.id}
            emptyTitle="No audit events"
            emptyDescription={entity ? `No events found for “${entity}”.` : governance ? "No governance events found." : "No audit events recorded yet."}
          />
        </CardBody>
      </Card>
    </div>
  );
}
