"use client";

import { useFormState, useFormStatus } from "react-dom";
import { resolveReview, type ReviewActionState } from "./actions";

function Decide({ state, label }: { state: "resolved" | "dismissed"; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" name="state" value={state} disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export interface ReviewItem {
  id: string;
  channel: string;
  provider_message_id: string;
  sender_identity: string | null;
  actor_type: string | null;
  identity_match: string | null;
  reason_code: string;
  reason_detail: string | null;
  body_excerpt: string | null;
  created_at: string;
}

/** Plain-English explanation of each reason code. The code is the record; this is the sentence. */
const REASON: Record<string, string> = {
  no_finance_classifier:
    "A staff member wrote in, and no classifier is configured to read it. Nothing was assumed about what they meant.",
  unroutable_identity: "The sender could not be matched to exactly one person or company record.",
  supplier_message: "A supplier wrote in. There is no automatic supplier flow yet.",
  staff_other: "A staff member wrote in about something that is not a finance capture.",
  not_finance_capture: "The message reached the finance route but did not qualify as a capture.",
  finance_gate_manual_review: "A finance message did not pass the deterministic gate.",
  unspecified: "No reason code was recorded.",
};

export function ReviewRow({ item }: { item: ReviewItem }) {
  const [state, formAction] = useFormState<ReviewActionState, FormData>(resolveReview, {});

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="card-title">{REASON[item.reason_code] ?? item.reason_code}</div>
          <div className="muted small mt-1">
            {item.channel} · from {item.sender_identity ?? "unknown sender"} ·{" "}
            {item.actor_type ?? "unresolved"} ({item.identity_match ?? "no match"}) ·{" "}
            {new Date(item.created_at).toLocaleString()}
          </div>
        </div>
        <code className="small dim">{item.reason_code}</code>
      </div>

      {item.body_excerpt && (
        <blockquote
          className="mt-2"
          style={{ borderLeft: "3px solid var(--line)", paddingLeft: 12, whiteSpace: "pre-wrap" }}
        >
          {/* Message text from outside the business. Shown as DATA. Anything in it that reads like
              an instruction is not one — no action here is driven by its content. */}
          {item.body_excerpt}
        </blockquote>
      )}
      {item.reason_detail && <p className="muted small mt-1">{item.reason_detail}</p>}

      <form action={formAction} className="stack gap-2 mt-2">
        <input type="hidden" name="reviewId" value={item.id} />
        <input name="note" className="input" placeholder="What did you do about it? (optional)" />
        <div className="row gap-2">
          <Decide state="resolved" label="Mark handled" />
          <Decide state="dismissed" label="Dismiss" />
        </div>
      </form>
      {state.error && <div className="notice err mt-2">{state.error}</div>}
      {state.ok && <div className="notice ok mt-2">{state.ok}</div>}
    </div>
  );
}
