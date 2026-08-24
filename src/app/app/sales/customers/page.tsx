/**
 * Customers — canonical customer identity (CRM-001).
 *
 * One customer record per real customer, with channel identities (WhatsApp, email,
 * etc.) attached. The canonical-customers section surfaces duplicates so a person can
 * merge them; the conversations section preserves the existing WhatsApp conversation view.
 */
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardHeader, CardBody, Badge, StatusBadge, DataTable } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Customers — Singha Central" };

interface ChannelIdentity {
  channel: string;
  identity: string;
}

interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  channel_identities: ChannelIdentity[];
}

interface Conversation {
  id: string;
  customer_wa_id: string;
  customer_name: string | null;
  status: string;
  last_inbound_at: string | null;
}

const CONVO_VARIANT: Record<string, "default" | "info" | "warn" | "ok"> = {
  collecting: "info",
  quoting: "info",
  awaiting_price: "warn",
  quoted: "ok",
};

/** Detect identities claimed by more than one active customer in the same company. */
function findDuplicateIdentities(customers: Customer[]): Map<string, string[]> {
  const byIdentity = new Map<string, string[]>();
  for (const c of customers) {
    if (c.status !== "active") continue;
    for (const ch of c.channel_identities) {
      const key = `${ch.channel}:${ch.identity}`;
      const list = byIdentity.get(key) ?? [];
      if (!list.includes(c.id)) list.push(c.id);
      byIdentity.set(key, list);
    }
  }
  const duplicates = new Map<string, string[]>();
  for (const [key, ids] of byIdentity) {
    if (ids.length > 1) duplicates.set(key, ids);
  }
  return duplicates;
}

export default async function CustomersPage() {
  const p = await requireDepartment("sales");
  const db = supabaseReadClient();

  const [{ data: rows }, { data: convos }] = await Promise.all([
    db
      .from("customers")
      .select("id, name, email, phone, status")
      .eq("company_id", p.companyId)
      .order("name", { ascending: true })
      .limit(500),
    db
      .from("wa_conversations")
      .select("id, customer_wa_id, customer_name, status, last_inbound_at")
      .eq("company_id", p.companyId)
      .order("updated_at", { ascending: false })
      .limit(200),
  ]);

  const customerIds = (rows ?? []).map((r: any) => r.id);
  const { data: channelRows } = customerIds.length
    ? await db
        .from("channel_identities")
        .select("actor_id, channel, identity")
        .eq("company_id", p.companyId)
        .eq("actor_type", "customer")
        .in("actor_id", customerIds)
    : { data: [] };

  const channelsByCustomer = new Map<string, ChannelIdentity[]>();
  for (const ch of channelRows ?? []) {
    const list = channelsByCustomer.get(ch.actor_id as string) ?? [];
    list.push({ channel: ch.channel as string, identity: ch.identity as string });
    channelsByCustomer.set(ch.actor_id as string, list);
  }

  const customers: Customer[] = (rows ?? []).map((r: any) => ({
    id: r.id,
    name: r.name,
    email: r.email,
    phone: r.phone,
    status: r.status,
    channel_identities: channelsByCustomer.get(r.id) ?? [],
  }));

  const duplicateIdentities = findDuplicateIdentities(customers);
  const duplicateCustomerIds = new Set<string>();
  for (const ids of duplicateIdentities.values()) {
    for (const id of ids) duplicateCustomerIds.add(id);
  }

  const conversations: Conversation[] = (convos ?? []) as Conversation[];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>Customers</h1>
          <p className="muted mt-1">Canonical records with channel identities. Duplicates are flagged, not merged silently.</p>
        </div>
        <Link className="btn ghost sm" href="/app/sales">← Sales</Link>
      </div>

      {duplicateCustomerIds.size > 0 && (
        <div className="notice warn">
          <strong>{duplicateCustomerIds.size}</strong> customer record{duplicateCustomerIds.size === 1 ? "" : "s"} share a channel identity with another record.
          Review and merge them manually.
        </div>
      )}

      <Card>
        <CardHeader title="Canonical customers" />
        <CardBody>
          <DataTable
            columns={[
              {
                key: "customer",
                header: "Customer",
                render: (c) => (
                  <span style={{ fontWeight: 600 }}>
                    {c.name}
                    {duplicateCustomerIds.has(c.id) && (
                      <Badge variant="warn" className="badge warn ml-1">duplicate</Badge>
                    )}
                  </span>
                ),
              },
              {
                key: "channels",
                header: "Channel identities",
                render: (c) =>
                  c.channel_identities.length === 0 ? (
                    "—"
                  ) : (
                    <div className="stack gap-0 dim small">
                      {c.channel_identities.map((ch, idx) => (
                        <div key={idx} className="mono">{ch.channel}: {ch.identity}</div>
                      ))}
                    </div>
                  ),
              },
              { key: "status", header: "Status", render: (c) => <StatusBadge status={c.status} /> },
            ]}
            rows={customers}
            keyExtractor={(c) => c.id}
            emptyTitle="No customers yet"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent WhatsApp conversations" />
        <CardBody>
          <DataTable
            columns={[
              { key: "customer", header: "Customer", render: (c) => <span style={{ fontWeight: 600 }}>{c.customer_name ?? "—"}</span> },
              { key: "number", header: "Number", render: (c) => <span className="mono dim">+{c.customer_wa_id}</span> },
              {
                key: "status",
                header: "Status",
                render: (c) => <Badge variant={CONVO_VARIANT[c.status] ?? "default"}>{c.status.replace("_", " ")}</Badge>,
              },
              { key: "last", header: "Last message", render: (c) => <span className="dim small">{fmtDateTime(c.last_inbound_at)}</span> },
              {
                key: "action",
                header: "",
                render: (c) => <Link className="btn ghost sm" href={`/app/sales/customers/${c.id}`}>View chat</Link>,
              },
            ]}
            rows={conversations}
            keyExtractor={(c) => c.id}
            emptyTitle="No customer conversations yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
