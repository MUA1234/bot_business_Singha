import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { Card, CardBody, Badge, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export const metadata = { title: "Conversation — Singha Central" };

const CONVO_VARIANT: Record<string, "default" | "info" | "warn" | "ok"> = {
  collecting: "info",
  quoting: "info",
  awaiting_price: "warn",
  quoted: "ok",
};

interface Message {
  id: string;
  direction: string;
  body: string;
  created_at: string;
}

export default async function ConversationPage({ params }: { params: { id: string } }) {
  const p = await requireDepartment("sales");
  const db = supabaseReadClient();

  const { data: convo } = await db
    .from("wa_conversations")
    .select("id, customer_wa_id, customer_name, status")
    .eq("id", params.id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!convo) notFound();

  const { data: messages } = await db
    .from("wa_messages")
    .select("id, direction, body, created_at")
    .eq("conversation_id", convo.id)
    .order("created_at", { ascending: true });

  const messageRows: Message[] = (messages ?? []) as Message[];

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{convo.customer_name ?? `+${convo.customer_wa_id}`}</h1>
          <p className="muted mt-1 mono">
            +{convo.customer_wa_id} · <Badge variant={CONVO_VARIANT[convo.status] ?? "default"}>{convo.status.replace("_", " ")}</Badge>
          </p>
        </div>
        <Link className="btn ghost sm" href="/app/sales/customers">← Back</Link>
      </div>

      <Card>
        <CardBody>
          <div className="stack gap-2" style={{ minWidth: 0 }}>
            {messageRows.length === 0 && <EmptyState title="No messages" icon="message-square" />}
            {messageRows.map((m) => {
              const inbound = m.direction === "inbound";
              return (
                <div
                  key={m.id}
                  style={{
                    alignSelf: inbound ? "flex-start" : "flex-end",
                    maxWidth: "min(78%, 520px)",
                    background: inbound ? "rgba(255,255,255,0.07)" : "var(--accent-grad)",
                    border: inbound ? "1px solid var(--panel-border)" : "none",
                    borderRadius: 14,
                    padding: "10px 14px",
                    minWidth: 0,
                  }}
                >
                  <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem", wordBreak: "break-word", overflowWrap: "anywhere" }}>
                    {m.body}
                  </div>
                  <div className="small" style={{ opacity: 0.7, marginTop: 4, textAlign: "right" }}>
                    {fmtDateTime(m.created_at)}
                  </div>
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
