/**
 * Suppliers — canonical supplier identity (CRM-002).
 *
 * One supplier record per real supplier, with channel identities (WhatsApp, email,
 * etc.) attached and duplicate identities surfaced. Bank-detail changes are a
 * separately approved maker-checker workflow (migration 0045); this page shows
 * current details and flags the control, not the edit form itself.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { counterpartyHealth } from "@/modules/crm/counterparty-compliance";
import { Card, CardHeader, CardBody, Badge, EmptyState, DataTable, type DataTableColumn } from "@/components/ui";
import { fmtDate } from "@/lib/format";

export const metadata = { title: "Suppliers — Singha Central" };

interface ChannelIdentity {
  channel: string;
  identity: string;
}

interface Supplier {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  bank_account_name: string | null;
  bank_account_number: string | null;
  status: string;
  compliance_status: string;
  insurance_status: string;
  insurance_expiry: string | null;
  channel_identities: ChannelIdentity[];
}

type BadgeVariant = "default" | "ok" | "warn" | "danger" | "info" | "accent";

/** Detect identities claimed by more than one active supplier in the same company. */
function findDuplicateIdentities(suppliers: Supplier[]): Map<string, string[]> {
  const byIdentity = new Map<string, string[]>();
  for (const s of suppliers) {
    if (s.status !== "active") continue;
    for (const ch of s.channel_identities) {
      const key = `${ch.channel}:${ch.identity}`;
      const list = byIdentity.get(key) ?? [];
      if (!list.includes(s.id)) list.push(s.id);
      byIdentity.set(key, list);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [key, ids] of byIdentity) {
    if (ids.length > 1) duplicates.set(key, ids);
  }
  return duplicates;
}

export default async function SuppliersPage() {
  const p = await requireDepartment("procurement");
  const db = supabaseReadClient();

  const { data: rows } = await db
    .from("suppliers")
    .select("id, name, email, phone, bank_account_name, bank_account_number, status, compliance_status, insurance_status, insurance_expiry")
    .eq("company_id", p.companyId)
    .order("name", { ascending: true })
    .limit(500);

  const supplierIds = (rows ?? []).map((r: any) => r.id);
  const { data: channelRows } = supplierIds.length
    ? await db
        .from("channel_identities")
        .select("actor_id, channel, identity")
        .eq("company_id", p.companyId)
        .eq("actor_type", "supplier")
        .in("actor_id", supplierIds)
    : { data: [] };

  const channelsBySupplier = new Map<string, ChannelIdentity[]>();
  for (const ch of channelRows ?? []) {
    const list = channelsBySupplier.get(ch.actor_id as string) ?? [];
    list.push({ channel: ch.channel as string, identity: ch.identity as string });
    channelsBySupplier.set(ch.actor_id as string, list);
  }

  const suppliers: Supplier[] = (rows ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    bank_account_name: r.bank_account_name,
    bank_account_number: r.bank_account_number,
    status: r.status,
    compliance_status: r.compliance_status ?? "pending",
    insurance_status: r.insurance_status ?? "pending",
    insurance_expiry: r.insurance_expiry ?? null,
    channel_identities: channelsBySupplier.get(r.id) ?? [],
  }));

  const duplicateIdentities = findDuplicateIdentities(suppliers);
  const duplicateSupplierIds = new Set<string>();
  for (const ids of duplicateIdentities.values()) {
    for (const id of ids) duplicateSupplierIds.add(id);
  }

  const columns: DataTableColumn<Supplier>[] = [
    {
      key: "name",
      header: "Supplier",
      render: (s) => {
        const isDuplicate = duplicateSupplierIds.has(s.id);
        const health = counterpartyHealth({
          status: s.status,
          compliance_status: s.compliance_status,
          insurance_status: s.insurance_status,
          insurance_expiry: s.insurance_expiry,
        });
        const healthBadge: BadgeVariant = health === "verified" ? "ok" : health === "blocked" ? "danger" : "warn";
        return (
          <div style={{ fontWeight: 600 }}>
            {s.name}
            {isDuplicate && <Badge variant="warn" className="ml-1">duplicate</Badge>}
            <Badge variant={healthBadge} className="ml-1">{health}</Badge>
          </div>
        );
      },
    },
    {
      key: "channels",
      header: "Channel identities",
      className: "dim small",
      render: (s) =>
        s.channel_identities.length === 0 ? (
          "—"
        ) : (
          <div className="stack gap-0">
            {s.channel_identities.map((ch, idx) => (
              <div key={idx} className="mono">{ch.channel}: {ch.identity}</div>
            ))}
          </div>
        ),
    },
    {
      key: "bank",
      header: "Bank details",
      className: "dim small",
      render: (s) => (
        <div className="stack gap-0">
          {s.bank_account_number ? (
            <>
              <div className="mono">{s.bank_account_number}</div>
              {s.bank_account_name && <div>{s.bank_account_name}</div>}
            </>
          ) : (
            <div>—</div>
          )}
          <Badge>changes require approval</Badge>
        </div>
      ),
    },
    {
      key: "compliance",
      header: "Compliance",
      render: (s) => <Badge>{s.compliance_status}</Badge>,
    },
    {
      key: "insurance",
      header: "Insurance",
      render: (s) => (
        <>
          <Badge>{s.insurance_status}</Badge>
          {s.insurance_expiry && <div className="dim small">expires {fmtDate(s.insurance_expiry)}</div>}
        </>
      ),
    },
  ];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Suppliers</h1>
          <p className="muted mt-1">Canonical records with channel identities and bank details. Duplicates are flagged; bank changes require approval.</p>
        </div>
        <Link className="btn ghost sm" href="/app/procurement">← Procurement</Link>
      </div>

      {duplicateSupplierIds.size > 0 && (
        <div className="notice warn">
          <strong>{duplicateSupplierIds.size}</strong> supplier record{duplicateSupplierIds.size === 1 ? "" : "s"} share a channel identity with another record.
          Review and merge them manually.
        </div>
      )}

      <Card>
        <CardHeader title="Canonical suppliers" />
        <CardBody>
          <DataTable
            columns={columns}
            rows={suppliers}
            keyExtractor={(s) => s.id}
            emptyTitle="No suppliers yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
