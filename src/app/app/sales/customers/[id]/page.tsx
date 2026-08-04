import { notFound } from "next/navigation";
import Link from "next/link";
import { requireDepartment } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export const metadata = { title: "Conversation — Singha" };

export default async function ConversationPage({ params }: { params: { id: string } }) {
  const p = await requireDepartment("sales");
  const db = supabaseAdmin();

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

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{convo.customer_name ?? `+${convo.customer_wa_id}`}</h1>
          <p className="muted mt-1 mono">+{convo.customer_wa_id} · {convo.status.replace("_", " ")}</p>
        </div>
        <Link className="btn ghost sm" href="/app/sales/customers">← Back</Link>
      </div>

      <div className="card">
        <div className="stack gap-2">
          {(messages ?? []).length === 0 && <div className="empty">No messages.</div>}
          {(messages ?? []).map((m: any) => {
            const inbound = m.direction === "inbound";
            return (
              <div
                key={m.id}
                style={{
                  alignSelf: inbound ? "flex-start" : "flex-end",
                  maxWidth: "78%",
                  background: inbound ? "rgba(255,255,255,0.07)" : "var(--accent-grad)",
                  border: inbound ? "1px solid var(--panel-border)" : "none",
                  borderRadius: 14,
                  padding: "10px 14px",
                }}
              >
                <div style={{ whiteSpace: "pre-wrap", fontSize: "0.9rem" }}>{m.body}</div>
                <div className="small" style={{ opacity: 0.7, marginTop: 4, textAlign: "right" }}>
                  {new Date(m.created_at).toLocaleTimeString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
