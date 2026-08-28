import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Badge, DataTable } from "@/components/ui";
import { Icon } from "@/components/Icon";
import { fmtDateTime, fmtNumber } from "@/lib/format";
import {
  Constellation,
  Matter,
  PageHead,
  Section,
  Signal,
  StateNote,
  type Cluster,
  type ConstellationNode,
} from "@/components/os/primitives";

export const metadata = { title: "Sales — Singha Central" };

async function count(table: string, companyId: string, extra?: (q: any) => any) {
  let q = supabaseReadClient().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  if (extra) q = extra(q);
  const { count } = await q;
  return count ?? 0;
}

interface RecentConversation {
  id: string;
  customer_wa_id: string;
  customer_name: string | null;
  status: string;
  updated_at: string;
}

const CONVO_VARIANT: Record<string, "default" | "info" | "warn" | "ok"> = {
  collecting: "info",
  quoting: "info",
  awaiting_price: "warn",
  quoted: "ok",
};

/**
 * How long a conversation has been quiet, in whole days. Used to place a
 * relationship in the field: active conversations sit toward the front, dormant
 * ones recede. Derived from `updated_at` — no engagement score, no inferred
 * intent, and no ranking of the person on the other end.
 */
function daysQuiet(updatedAt: string, now: Date): number {
  const t = Date.parse(updatedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.floor((now.getTime() - t) / 86_400_000));
}

export default async function SalesHome() {
  const p = await requireDepartment("sales");
  const now = new Date();

  const [newOrders, quotes, openPrice, convos] = await Promise.all([
    count("orders", p.companyId, (q) => q.eq("status", "new")),
    count("quotations", p.companyId),
    count("price_confirmations", p.companyId, (q) => q.eq("status", "open")),
    count("wa_conversations", p.companyId),
  ]);

  const { data: recent } = await supabaseReadClient()
    .from("wa_conversations")
    .select("id, customer_wa_id, customer_name, status, updated_at")
    .eq("company_id", p.companyId)
    .order("updated_at", { ascending: false })
    .limit(60);

  const recentRows: RecentConversation[] = (recent ?? []) as RecentConversation[];

  // ── The customer relationship field ────────────────────────────────────
  // Conversations needing a human sit toward the front; quiet ones recede.
  const needsHuman: ConstellationNode[] = [];
  const active: ConstellationNode[] = [];
  const quiet: ConstellationNode[] = [];
  const dormant: ConstellationNode[] = [];

  for (const c of recentRows) {
    const quietDays = daysQuiet(c.updated_at, now);
    const node: ConstellationNode = {
      id: c.id,
      label: c.customer_name ?? `+${c.customer_wa_id}`,
      meta: quietDays === 0 ? "today" : `${quietDays}d`,
      href: `/app/sales/customers/${c.id}`,
      icon: "message-square",
    };
    if (c.status === "awaiting_price") {
      needsHuman.push({ ...node, band: "critical" });
    } else if (quietDays <= 2) {
      active.push({ ...node, band: "high" });
    } else if (quietDays <= 14) {
      quiet.push({ ...node, band: "normal" });
    } else {
      dormant.push({ ...node, band: "done" });
    }
  }

  const clusters: Cluster[] = [
    { key: "needs-human", name: "Waiting on a person here", nodes: needsHuman },
    { key: "active", name: "Active — spoke within two days", nodes: active },
    { key: "quiet", name: "Quiet — two to fourteen days", nodes: quiet },
    { key: "dormant", name: "Dormant — over fourteen days", nodes: dormant },
  ];

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Customers"
        title="Relationship field"
        lede="Conversations arrive from WhatsApp and become quotations. Position here reflects how recently we spoke and whether the conversation is waiting on us — nothing on this screen scores a customer."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/sales/quotations">Quotations</Link>
            <Link className="btn ghost sm" href="/app/sales/opportunities">Opportunities</Link>
          </>
        }
      />

      <Section title="Position" />
      <div className="grid cols-4">
        <Link href="/app/sales/orders" className="card stat">
          <div className="k">New orders</div>
          <div className="v">{fmtNumber(newOrders)}</div>
          <div className="d">Not yet actioned</div>
        </Link>
        <Link href="/app/sales/quotations" className="card stat">
          <div className="k">Quotations</div>
          <div className="v">{fmtNumber(quotes)}</div>
          <div className="d">Raised in this company</div>
        </Link>
        <Link href="/app/sales/price-requests" className="card stat">
          <div className="k">Price confirmations</div>
          <div className="v">{fmtNumber(openPrice)}</div>
          <div className="d">
            {openPrice > 0 ? (
              <Signal kind="warn">Blocking a quotation</Signal>
            ) : (
              <Signal kind="ok">Nothing awaiting a price</Signal>
            )}
          </div>
        </Link>
        <Link href="/app/sales/customers" className="card stat">
          <div className="k">Conversations</div>
          <div className="v">{fmtNumber(convos)}</div>
          <div className="d">All time</div>
        </Link>
      </div>

      {(openPrice > 0 || needsHuman.length > 0 || newOrders > 0) && (
        <>
          <Section title="Needs a person" />
          <div className="field-matters">
            {needsHuman.length > 0 && (
              <Matter
                kind="Awaiting a price"
                kindIcon="help-circle"
                band="critical"
                title={`${needsHuman.length} conversation${needsHuman.length === 1 ? "" : "s"} cannot proceed without a price`}
                href="/app/sales/price-requests"
                footer={<Signal kind="critical">The customer is waiting on us</Signal>}
              />
            )}
            {openPrice > 0 && (
              <Matter
                kind="Price confirmations"
                kindIcon="help-circle"
                band="high"
                title={`${openPrice} open price confirmation${openPrice === 1 ? "" : "s"}`}
                href="/app/sales/price-requests"
                footer={<Signal kind="warn">A quotation cannot be sent until these are priced</Signal>}
              />
            )}
            {newOrders > 0 && (
              <Matter
                kind="New orders"
                kindIcon="package"
                band="high"
                title={`${newOrders} order${newOrders === 1 ? "" : "s"} have not been actioned`}
                href="/app/sales/orders"
                footer={<Signal kind="warn">Nobody has picked these up yet</Signal>}
              />
            )}
          </div>
        </>
      )}

      <Section
        title="Customer relationship field"
        meta="the 60 most recently updated conversations"
      />
      {recentRows.length === 0 ? (
        <StateNote kind="empty" title="No conversations yet">
          Conversations appear here when customers message your WhatsApp number.
        </StateNote>
      ) : (
        <div className="card pad-lg">
          <Constellation clusters={clusters} />
        </div>
      )}

      <Section title="Most recent" meta="detail view" />
      <div className="card">
        <DataTable
          columns={[
            {
              key: "customer",
              header: "Customer",
              render: (c: RecentConversation) => (
                <Link href={`/app/sales/customers/${c.id}`} style={{ fontWeight: 600 }}>
                  {c.customer_name ?? "—"}
                </Link>
              ),
            },
            { key: "number", header: "Number", render: (c: RecentConversation) => <span className="mono dim">+{c.customer_wa_id}</span> },
            {
              key: "status",
              header: "Status",
              render: (c: RecentConversation) => (
                <Badge variant={CONVO_VARIANT[c.status] ?? "default"}>{c.status.replace("_", " ")}</Badge>
              ),
            },
            { key: "updated", header: "Updated", render: (c: RecentConversation) => <span className="dim small">{fmtDateTime(c.updated_at)}</span> },
          ]}
          rows={recentRows.slice(0, 12)}
          keyExtractor={(c) => c.id}
          emptyTitle="No conversations yet"
          emptyDescription="They appear when customers message your WhatsApp number."
        />
      </div>

      <Section title="The rest of Sales" />
      <div className="grid cols-3">
        {[
          { href: "/app/sales/orders", label: "Orders", icon: "package", note: "What customers have asked for" },
          { href: "/app/sales/quotations", label: "Quotations", icon: "file-text", note: "Priced offers and their state" },
          { href: "/app/sales/price-requests", label: "Price confirmations", icon: "help-circle", note: "Prices a person must confirm" },
          { href: "/app/sales/customers", label: "Conversations", icon: "message-square", note: "Every WhatsApp thread" },
          { href: "/app/sales/accounts", label: "Customer accounts", icon: "user-round", note: "Identity, consent and history" },
          { href: "/app/sales/leads", label: "Leads", icon: "target", note: "Enquiries not yet qualified" },
          { href: "/app/sales/opportunities", label: "Opportunities", icon: "rocket", note: "Live pursuits and their value" },
        ].map((item) => (
          <Link key={item.href} href={item.href} className="node-card">
            <span className="node-card-ico" aria-hidden="true">
              <Icon name={item.icon} size={17} strokeWidth={1.6} />
            </span>
            <span className="node-card-text">
              <span className="node-card-title">{item.label}</span>
              <span className="node-card-note">{item.note}</span>
            </span>
            <Icon name="chevron-right" size={15} className="dim" aria-hidden="true" />
          </Link>
        ))}
      </div>
    </div>
  );
}
