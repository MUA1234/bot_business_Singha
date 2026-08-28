/**
 * Admin → Audit Log (§13). The append-only trail of privileged and AI actions,
 * company-scoped. Read-only; supports a simple entity filter via ?entity=. Every
 * action here was recorded by a domain service — the ledger of who did what.
 *
 * The surface is the trust feature (§47): who acted, when, on what, and — most
 * importantly — WHETHER IT WAS A PERSON, THE SYSTEM OR THE AI. The actor is
 * carried by the provenance rule, not by a badge colour alone, so the
 * distinction survives greyscale and a screen reader. Two views of the same
 * rows are offered: a timeline for reading a sequence, and a table for finding
 * one row.
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { describeAction } from "@/lib/audit-format";
import { Badge } from "@/components/ui/Badge";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { fmtDateTime } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { ViewSwitcher } from "@/components/os/ViewSwitcher";
import { PageHead, Section, StateNote } from "@/components/os/primitives";

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

/** Which provenance rule an actor gets. Human action and AI action never look alike. */
function actorProvenance(actorType: string): "ai" | "system" | "human" {
  if (actorType === "ai") return "ai";
  if (actorType === "system") return "system";
  return "human";
}

const ACTOR_LABEL: Record<string, string> = {
  ai: "AI action",
  system: "System action",
};

export default async function AuditPage({ searchParams }: { searchParams: { entity?: string; governance?: string } }) {
  const admin = await requireAdmin();
  const entity = (searchParams.entity ?? "").trim();
  const governance = searchParams.governance === "1" || searchParams.governance === "true";

  let rows: AuditRow[] = [];
  let readFailed = false;
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
    readFailed = true;
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

  // Group the trail by day so a reader can follow a sequence rather than scan a
  // flat list of timestamps.
  const byDay = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const day = r.created_at.slice(0, 10);
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }

  const humanCount = rows.filter((r) => actorProvenance(r.actor_type) === "human").length;
  const aiCount = rows.filter((r) => actorProvenance(r.actor_type) === "ai").length;
  const systemCount = rows.length - humanCount - aiCount;

  const timelineView =
    rows.length === 0 ? (
      <StateNote kind="empty" title="No audit events">
        {entity
          ? `No events recorded for “${entity}”.`
          : governance
            ? "No governance events recorded."
            : "No audit events recorded yet in this company."}
      </StateNote>
    ) : (
      <div className="card pad-lg">
        {[...byDay.entries()].map(([day, dayRows]) => (
          <div key={day} style={{ marginBottom: "var(--sp-5)" }}>
            <div className="sec" style={{ marginTop: 0 }}>
              <span className="sec-title">{day}</span>
              <span className="sec-rule" />
              <span className="sec-meta">{dayRows.length} event(s)</span>
            </div>
            <div className="stack gap-2">
              {dayRows.map((r) => {
                const kind = actorProvenance(r.actor_type);
                return (
                  <div className={`prov prov-${kind}`} key={r.id}>
                    <span className="prov-label">
                      <Icon
                        name={kind === "ai" ? "sparkles" : kind === "system" ? "database" : "user-round"}
                        size={11}
                        aria-hidden="true"
                      />
                      {ACTOR_LABEL[r.actor_type] ?? "Human action"}
                    </span>
                    <div className="row between wrap gap-2" style={{ marginTop: 4 }}>
                      <span style={{ fontSize: "var(--t-data)", fontWeight: 650 }}>
                        {describeAction(r.action)}
                      </span>
                      <span className="dim small mono">
                        {r.entity_type}
                        {r.entity_id ? ` · ${String(r.entity_id).slice(0, 8)}` : ""}
                      </span>
                    </div>
                    <div className="dim small" style={{ marginTop: 2 }}>
                      {fmtDateTime(r.created_at)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    );

  const tableView = (
    <div className="card">
      <DataTable
        columns={columns}
        rows={rows}
        keyExtractor={(r) => r.id}
        emptyTitle="No audit events"
        emptyDescription={entity ? `No events found for “${entity}”.` : governance ? "No governance events found." : "No audit events recorded yet."}
      />
    </div>
  );

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Platform"
        title="Audit trail"
        lede="Append-only record of privileged and AI actions. Nothing here can be edited or deleted — a correction is itself a recorded action."
        actions={
          <>
            <a className="btn ghost sm" href="/api/exports/audit">
              <Icon name="download" size={14} /> Export CSV
            </a>
            <Link className="btn ghost sm" href="/app/admin">Admin</Link>
          </>
        }
      />

      {readFailed && (
        <StateNote kind="error" title="The audit trail could not be read">
          This is not a statement that nothing happened. The trail is append-only and intact; this
          screen simply could not reach it.
        </StateNote>
      )}

      <Section title="Filter" meta={`${rows.length} event${rows.length === 1 ? "" : "s"} in view`} />
      <div className="row gap-1 wrap">
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

      <Section title="Who acted" meta="a person, the system, or the AI — never blurred" />
      <div className="grid cols-3">
        <div className="card stat">
          <div className="k">Human actions</div>
          <div className="v">{humanCount}</div>
          <div className="d">A named person took this action</div>
        </div>
        <div className="card stat">
          <div className="k">System actions</div>
          <div className="v">{systemCount}</div>
          <div className="d">A deterministic service, on a rule</div>
        </div>
        <div className="card stat">
          <div className="k">AI actions</div>
          <div className="v">{aiCount}</div>
          <div className="d">Observed or proposed — never authorised</div>
        </div>
      </div>

      <Section title="The trail" meta="most recent first, 300 most recent events" />
      <ViewSwitcher
        storageKey="singha.os.view.audit"
        views={[
          { key: "timeline", label: "Timeline", icon: "scroll-text", node: timelineView },
          { key: "table", label: "Table", icon: "rows", node: tableView },
        ]}
      />
    </div>
  );
}
