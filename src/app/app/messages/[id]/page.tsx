/**
 * Communications — a single customer conversation.
 *
 * Visible to EVERY signed-in employee (requireProfile, no department gate). The
 * conversation is looked up scoped to the caller's company_id so no
 * cross-company thread can ever be opened by id, and the sibling list is
 * scoped the same way.
 *
 * The surface is the unified communications composition (§32): the people layer
 * on the left, the active conversation in the centre, and the context layer on
 * the right. It is deliberately NOT a WhatsApp clone — the context layer is the
 * point, because a person answering a customer needs the identity, the state and
 * the related records in view while they type.
 */
import { notFound } from "next/navigation";
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { EmptyState } from "@/components/ui/EmptyState";
import { Icon } from "@/components/Icon";
import { fmtDateTime } from "@/lib/format";

import { supabaseReadClient } from "@/lib/supabase/read";
import { analyzeConversation } from "./actions";
import { Facts, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Conversation — Singha Central" };

const ERRORS: Record<string, string> = {
  ai_off: "AI gateway not configured (OPENAI_API_KEY).",
  ai_error: "This conversation could not be analysed.",
  forbidden: "Only an admin can run an analysis.",
  not_found: "Conversation not found.",
};

const STATUS_SIGNAL: Record<string, "ok" | "warn" | "info" | "blocked"> = {
  collecting: "info",
  quoting: "info",
  awaiting_price: "warn",
  quoted: "ok",
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

  const [{ data: messages }, { data: siblings }] = await Promise.all([
    db
      .from("wa_messages")
      .select("id, direction, body, created_at")
      .eq("conversation_id", convo.id)
      .eq("company_id", p.companyId)
      .order("created_at", { ascending: true }),
    db
      .from("wa_conversations")
      .select("id, customer_wa_id, customer_name, status, updated_at")
      .eq("company_id", p.companyId)
      .order("updated_at", { ascending: false })
      .limit(40),
  ]);

  const thread = (messages ?? []) as any[];
  const list = (siblings ?? []) as any[];
  const lastInbound = [...thread].reverse().find((m) => m.direction === "inbound");
  const lastOutbound = [...thread].reverse().find((m) => m.direction === "outbound");
  // "Unanswered" is a fact about the thread, not an inference: the newest
  // message is inbound and no outbound message follows it.
  const unanswered = Boolean(lastInbound) && thread[thread.length - 1]?.direction === "inbound";

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Communications"
        title={convo.customer_name ?? `+${convo.customer_wa_id}`}
        lede={`+${convo.customer_wa_id} · ${convo.status.replace("_", " ")}`}
        actions={
          <>
            {p.isAdmin && (
              <form action={analyzeConversation}>
                <input type="hidden" name="conversation_id" value={convo.id} />
                <button className="btn ghost sm" type="submit">
                  <Icon name="sparkles" size={14} /> Analyse with AI
                </button>
              </form>
            )}
            <Link className="btn ghost sm" href="/app/messages">
              <Icon name="chevron-left" size={14} /> All messages
            </Link>
          </>
        }
      />

      {searchParams.captured !== undefined && (
        <div className="notice ok">
          Analysis captured {searchParams.captured} task(s) from this conversation — see{" "}
          <Link href="/app/operations/tasks">Operations → Tasks</Link>. It read the thread only;
          nothing was sent to the customer.
        </div>
      )}
      {searchParams.err && <div className="notice err">{ERRORS[searchParams.err] ?? "Something went wrong."}</div>}

      <div className="split-wide">
        {/* ── PEOPLE LAYER ────────────────────────────────────────────── */}
        <aside className="split-aside-left split-aside">
          <div className="card" style={{ padding: "var(--sp-3)" }}>
            <Section title="Conversations" meta={`${list.length}`} />
            <div className="stack gap-1" style={{ maxHeight: "62vh", overflowY: "auto" }}>
              {list.map((c) => (
                <Link
                  key={c.id}
                  href={`/app/messages/${c.id}`}
                  className="node-card"
                  aria-current={c.id === convo.id ? "page" : undefined}
                  style={
                    c.id === convo.id
                      ? { borderColor: "rgba(var(--accent-rgb), 0.4)", background: "rgba(var(--accent-rgb), 0.07)" }
                      : undefined
                  }
                >
                  <span className="node-card-text">
                    <span className="node-card-title">{c.customer_name ?? `+${c.customer_wa_id}`}</span>
                    <span className="node-card-note">{c.status.replace("_", " ")}</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </aside>

        {/* ── THE CONVERSATION ────────────────────────────────────────── */}
        <div style={{ minWidth: 0 }}>
          <div className="card">
            <div className="thread">
              {thread.length === 0 && <EmptyState title="No messages." icon="message-square" />}
              {thread.map((m: any) => {
                const inbound = m.direction === "inbound";
                return (
                  <div key={m.id} className={`bubble${inbound ? "" : " is-ours"}`}>
                    <div className="bubble-body">{m.body}</div>
                    <div className="bubble-when">
                      {inbound ? "Customer" : "Us"} ·{" "}
                      {new Date(m.created_at).toLocaleTimeString(undefined, {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <p className="small dim mt-2">
            Replies are sent by the WhatsApp flow, not composed here. Outside the 24-hour
            customer-service window only an approved template may be sent — the system enforces that
            rather than relying on the sender to remember it.
          </p>
        </div>

        {/* ── CONTEXT LAYER ───────────────────────────────────────────── */}
        <aside className="split-aside">
          <div className="card">
            <Section title="Context" />
            {unanswered ? (
              <div style={{ marginBottom: "var(--sp-3)" }}>
                <StateNote kind="review" title="Unanswered">
                  The most recent message is from the customer and nothing has been sent since.
                </StateNote>
              </div>
            ) : (
              <div style={{ marginBottom: "var(--sp-3)" }}>
                <Signal kind="ok">Last word was ours</Signal>
              </div>
            )}
            <Facts
              items={[
                { k: "Customer", v: convo.customer_name ?? "", missing: !convo.customer_name },
                { k: "Number", v: `+${convo.customer_wa_id}` },
                { k: "State", v: convo.status.replace("_", " ") },
                { k: "Messages", v: String(thread.length), numeric: true },
                {
                  k: "Last from customer",
                  v: lastInbound ? fmtDateTime(lastInbound.created_at) : "",
                  missing: !lastInbound,
                },
                {
                  k: "Last from us",
                  v: lastOutbound ? fmtDateTime(lastOutbound.created_at) : "",
                  missing: !lastOutbound,
                },
              ]}
            />
            <div className="card-footer" style={{ justifyContent: "flex-start" }}>
              <Link className="btn ghost sm" href="/app/sales/quotations">Quotations</Link>
              <Link className="btn ghost sm" href="/app/sales/price-requests">Price confirmations</Link>
            </div>
          </div>

          <div className="card mt-2">
            <Section title="Conversation state" />
            <div className="stack gap-2">
              <Signal kind={STATUS_SIGNAL[convo.status] ?? "info"}>
                {convo.status.replace("_", " ")}
              </Signal>
              <p className="small muted">
                {convo.status === "awaiting_price"
                  ? "A price must be confirmed by a person before a quotation can be produced. The customer has not been told a price."
                  : convo.status === "quoted"
                    ? "A quotation has been produced from this conversation."
                    : "The conversation is being collected and understood. No commitment has been made to the customer."}
              </p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
