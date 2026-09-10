"use client";

/**
 * Client-safe presentational content for the Customers panel.
 * Loaded data is passed in from `CustomersPanel`.
 */
import Link from "next/link";
import { Card, CardHeader, CardBody, Badge, StatusBadge, DataTable } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import type { PlainObject } from "./CustomersPanel";

export interface ChannelIdentity {
  channel: string;
  identity: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  status: string;
  channel_identities: ChannelIdentity[];
}

export interface Conversation {
  id: string;
  customer_wa_id: string;
  customer_name: string | null;
  status: string;
  last_inbound_at: string | null;
}

export interface CustomersPanelData {
  customers: Customer[];
  conversations: Conversation[];
  duplicateCustomerIds: string[];
}

const CONVO_VARIANT: Record<string, "default" | "info" | "warn" | "ok"> = {
  collecting: "info",
  quoting: "info",
  awaiting_price: "warn",
  quoted: "ok",
};

export function CustomersPanelContent({
  data,
  embedded,
}: {
  data: PlainObject;
  embedded?: boolean;
}) {
  const { customers, conversations, duplicateCustomerIds } = data as unknown as CustomersPanelData;
  const duplicateSet = new Set(duplicateCustomerIds);

  return (
    <div className="stack gap-3">
      {!embedded && (
        <div className="row between">
          <div>
            <h1>Customers</h1>
            <p className="muted mt-1">Canonical records with channel identities. Duplicates are flagged, not merged silently.</p>
          </div>
          <Link className="btn ghost sm" href="/app/sales">← Sales</Link>
        </div>
      )}

      {duplicateSet.size > 0 && (
        <div className="notice warn">
          <strong>{duplicateSet.size}</strong> customer record{duplicateSet.size === 1 ? "" : "s"} share a channel identity with another record.
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
                render: (c: Customer) => (
                  <span style={{ fontWeight: 600 }}>
                    {c.name}
                    {duplicateSet.has(c.id) && (
                      <Badge variant="warn" className="badge warn ml-1">duplicate</Badge>
                    )}
                  </span>
                ),
              },
              {
                key: "channels",
                header: "Channel identities",
                render: (c: Customer) =>
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
              { key: "status", header: "Status", render: (c: Customer) => <StatusBadge status={c.status} /> },
            ]}
            rows={customers}
            keyExtractor={(c: Customer) => c.id}
            emptyTitle="No customers yet"
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Recent WhatsApp conversations" />
        <CardBody>
          <DataTable
            columns={[
              { key: "customer", header: "Customer", render: (c: Conversation) => <span style={{ fontWeight: 600 }}>{c.customer_name ?? "—"}</span> },
              { key: "number", header: "Number", render: (c: Conversation) => <span className="mono dim">+{c.customer_wa_id}</span> },
              {
                key: "status",
                header: "Status",
                render: (c: Conversation) => <Badge variant={CONVO_VARIANT[c.status] ?? "default"}>{c.status.replace("_", " ")}</Badge>,
              },
              { key: "last", header: "Last message", render: (c: Conversation) => <span className="dim small">{fmtDateTime(c.last_inbound_at)}</span> },
              {
                key: "action",
                header: "",
                render: (c: Conversation) => <Link className="btn ghost sm" href={`/app/sales/customers/${c.id}`}>View chat</Link>,
              },
            ]}
            rows={conversations}
            keyExtractor={(c: Conversation) => c.id}
            emptyTitle="No customer conversations yet"
          />
        </CardBody>
      </Card>
    </div>
  );
}
