/**
 * A single customer conversation thread. Visible to EVERY signed-in employee
 * (requireProfile, no department gate). The conversation is looked up scoped to the
 * caller's company_id so no cross-company thread can ever be opened by id.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";

import { supabaseReadClient } from "@/lib/supabase/read";
import { analyzeConversation } from "./actions";

export const metadata = { title: "Conversation — Singha Central" };

const ERRORS: Record<string, string> = {
  ai_off: "AI gateway not configured (OPENAI_API_KEY).",
  ai_error: "This conversation could not be analysed.",
  forbidden: "Only an admin can run an analysis.",
  not_found: "Conversation not found.",
};

export default async function ThreadPage({ params, searchParams }: { params: { id: string }; searchParams: { captured?: string; err?: string } }) {
  const p = await requireProfile();
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
    .eq("company_id", p.companyId)
    .order("created_at", { ascending: true });

  return (
    <div className="stack gap-3">
      <div className="row between">
        <div>
          <h1>{convo.customer_name ?? `+${convo.customer_wa_id}`}</h1>
          <p className="muted mt-1 mono">+{convo.customer_wa_id} · {convo.status.replace("_", " ")}</p>
        </div>
        <div className="row gap-1">
          {p.isAdmin && (
            <form action={analyzeConversation}>
              <input type="hidden" name="conversation_id" value={convo.id} />
              <button className="btn ghost sm" type="submit">Analyse with AI</button>
            </form>
          )}
          <Link className="btn ghost sm" href="/app/messages">← All messages</Link>
        </div>
      </div>

      {searchParams.captured !== undefined && (
        <div className="notice ok">Analysis captured {searchParams.captured} task(s) from this conversation — see <Link href="/app/operations/tasks">Operations → Tasks</Link>. It read the thread only; nothing was sent to the customer.</div>
      )}
      {searchParams.err && <div className="notice err">{ERRORS[searchParams.err] ?? "Something went wrong."}</div>}

      <div className="card">
        <div className="stack gap-2">
          {(messages ?? []).length === 0 && <EmptyState title="No messages." icon="message-square" />}
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
