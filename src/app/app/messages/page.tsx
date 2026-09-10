/**
 * Communications — the company-wide customer inbox.
 *
 * Unlike /app/sales/customers (sales-only), this is visible to EVERY signed-in
 * employee (requireProfile, no department gate). Reads are service-role but
 * always scoped to the caller's company_id.
 *
 * Conversations are ordered by what needs a person, not merely by recency: a
 * thread whose newest message is inbound is UNANSWERED, which is a fact about
 * the rows rather than an inference about intent.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { Badge } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Messages — Singha Central" };

interface Convo {
  id: string;
  customer_wa_id: string;
  customer_name: string | null;
  status: string;
  last_inbound_at: string | null;
  updated_at: string;
}

export default async function MessagesPage() {
  const p = await requireProfile();
  const db = supabaseReadClient();

  const { data: convos } = await db
    .from("wa_conversations")
    .select("id, customer_wa_id, customer_name, status, last_inbound_at, updated_at")
    .eq("company_id", p.companyId)
    .order("updated_at", { ascending: false })
    .limit(100);

  const list = (convos ?? []) as Convo[];

  // Latest message per conversation, for an inbox-style preview. One extra query,
  // reduced to first-per-conversation in JS (newest first).
  const preview = new Map<string, { body: string | null; direction: string; created_at: string }>();
  if (list.length) {
    const { data: msgs } = await db
      .from("wa_messages")
      .select("conversation_id, body, direction, created_at")
      .eq("company_id", p.companyId)
      .in("conversation_id", list.map((c) => c.id))
      .order("created_at", { ascending: false })
      .limit(1000);
    for (const m of (msgs ?? []) as any[]) {
      if (!preview.has(m.conversation_id)) preview.set(m.conversation_id, m);
    }
  }

  const unanswered = list.filter((c) => preview.get(c.id)?.direction === "inbound");
  const awaitingPrice = list.filter((c) => c.status === "awaiting_price");

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Communications"
        title="Customer messages"
        lede="Every customer WhatsApp conversation in this company, visible to all staff. A conversation is marked unanswered when its most recent message came from the customer."
      />

      {(unanswered.length > 0 || awaitingPrice.length > 0) && (
        <>
          <Section title="Waiting on us" />
          <div className="field-matters">
            {unanswered.length > 0 && (
              <Matter
                kind="Unanswered"
                kindIcon="message-square"
                band="critical"
                title={`${unanswered.length} conversation${unanswered.length === 1 ? "" : "s"} where the customer spoke last`}
                href={`/app/messages/${unanswered[0]!.id}`}
                footer={<Signal kind="critical">Open the oldest first</Signal>}
              />
            )}
            {awaitingPrice.length > 0 && (
              <Matter
                kind="Awaiting a price"
                kindIcon="help-circle"
                band="high"
                title={`${awaitingPrice.length} conversation${awaitingPrice.length === 1 ? "" : "s"} cannot proceed without a confirmed price`}
                href="/app/sales/price-requests"
                footer={<Signal kind="warn">A person must confirm the price</Signal>}
              />
            )}
          </div>
        </>
      )}

      <Section title="Inbox" meta={`${list.length} conversation${list.length === 1 ? "" : "s"}`} />
      {list.length === 0 ? (
        <StateNote kind="empty" title="No customer conversations yet">
          Conversations appear here when customers message your WhatsApp number.
        </StateNote>
      ) : (
        <div className="card">
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Number</th>
                  <th>Latest message</th>
                  <th>State</th>
                  <th>Last activity</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const pv = preview.get(c.id);
                  const waiting = pv?.direction === "inbound";
                  const text = pv?.body ? `${pv.direction === "outbound" ? "Us: " : ""}${pv.body}` : "—";
                  return (
                    <tr key={c.id} className={waiting ? "is-priority" : undefined}>
                      <td style={{ fontWeight: 600 }}>
                        <Link href={`/app/messages/${c.id}`}>{c.customer_name ?? "—"}</Link>
                      </td>
                      <td className="mono dim">+{c.customer_wa_id}</td>
                      <td
                        className="small"
                        style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {text}
                      </td>
                      <td>
                        {waiting ? (
                          <Signal kind="warn">Unanswered</Signal>
                        ) : (
                          <Badge>{c.status.replace("_", " ")}</Badge>
                        )}
                      </td>
                      <td className="dim small">
                        {c.last_inbound_at ? fmtDateTime(c.last_inbound_at) : "—"}
                      </td>
                      <td>
                        <Link className="btn ghost sm" href={`/app/messages/${c.id}`}>
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
