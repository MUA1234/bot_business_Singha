/**
 * Company-wide customer messages inbox. Unlike /app/sales/customers (sales-only),
 * this is visible to EVERY signed-in employee (requireProfile, no department gate).
 * Reads are service-role but always scoped to the caller's company_id.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";

export const metadata = { title: "Messages — Singha" };

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
  const preview = new Map<string, { body: string | null; direction: string }>();
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

  return (
    <div className="stack gap-3">
      <div>
        <h1>Messages</h1>
        <p className="muted mt-1">Every customer WhatsApp conversation. Visible to all staff.</p>
      </div>

      <div className="card">
        {list.length === 0 ? (
          <div className="empty">No customer conversations yet.</div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Number</th>
                  <th>Latest message</th>
                  <th>Status</th>
                  <th>Last activity</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {list.map((c) => {
                  const pv = preview.get(c.id);
                  const text = pv?.body
                    ? `${pv.direction === "outbound" ? "You: " : ""}${pv.body}`
                    : "—";
                  return (
                    <tr key={c.id}>
                      <td style={{ fontWeight: 600 }}>{c.customer_name ?? "—"}</td>
                      <td className="mono dim">+{c.customer_wa_id}</td>
                      <td
                        className="small"
                        style={{ maxWidth: 340, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      >
                        {text}
                      </td>
                      <td><span className="badge">{c.status.replace("_", " ")}</span></td>
                      <td className="dim small">
                        {c.last_inbound_at ? new Date(c.last_inbound_at).toLocaleString() : "—"}
                      </td>
                      <td><Link className="btn ghost sm" href={`/app/messages/${c.id}`}>Open</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
