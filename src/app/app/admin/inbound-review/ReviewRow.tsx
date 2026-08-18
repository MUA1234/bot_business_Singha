"use client";

import type { ComponentType, ReactNode } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { resolveReview, type ReviewActionState } from "./actions";

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

export interface DecideProps { state: "resolved" | "dismissed"; label: string }

/** The button as it renders. Pure, so what a reviewer sees can be asserted without a browser. */
export function PlainDecide({ state, label }: DecideProps) {
  return <button className="btn" type="submit" name="state" value={state}>{label}</button>;
}

/** The interactive button: same markup, plus the pending affordance. */
function LiveDecide({ state, label }: DecideProps) {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" name="state" value={state} disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

/**
 * Everything the queue SHOWS about one item.
 *
 * Split from the hook-bearing wrapper on purpose: a component calling `useFormState` cannot render
 * outside the server-actions runtime, so its claims could only be checked by reading source text —
 * and such a test passes even when the block is never rendered. This one renders, so
 * `tests/campaign/ui-rendered-truthfulness.test.ts` asserts the words a reviewer actually sees.
 */
export function ReviewRowView({
  item,
  action,
  notice,
  Decide = PlainDecide,
}: {
  item: ReviewItem;
  action?: (formData: FormData) => void;
  notice?: ReactNode;
  Decide?: ComponentType<DecideProps>;
}) {
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <div className="card-title">{REASON[item.reason_code] ?? item.reason_code}</div>
          <div className="muted small mt-1">
            {item.channel} · from {item.sender_identity ?? "unknown sender"} ·{" "}
            {item.actor_type ?? "unresolved"} ({item.identity_match ?? "no match"}) ·{" "}
            {new Date(item.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC
          </div>
        </div>
        <code className="small dim">{item.reason_code}</code>
      </div>

      {item.body_excerpt && (
        <blockquote
          className="mt-2"
          style={{ borderLeft: "3px solid var(--line)", paddingLeft: 12, whiteSpace: "pre-wrap" }}
        >
          {/* Message text from outside the business. Shown as DATA — React escapes it, and nothing
              on this page acts on what it says. */}
          {item.body_excerpt}
        </blockquote>
      )}
      {item.reason_detail && <p className="muted small mt-1">{item.reason_detail}</p>}

      <form action={action} className="stack gap-2 mt-2">
        <input type="hidden" name="reviewId" value={item.id} />
        <input name="note" className="input" placeholder="What did you do about it? (optional)" />
        <div className="row gap-2">
          <Decide state="resolved" label="Mark handled" />
          <Decide state="dismissed" label="Dismiss" />
        </div>
      </form>
      {notice}
    </div>
  );
}

export function ReviewRow({ item }: { item: ReviewItem }) {
  const [state, formAction] = useFormState<ReviewActionState, FormData>(resolveReview, {});
  return (
    <ReviewRowView
      item={item}
      action={formAction}
      Decide={LiveDecide}
      notice={
        <>
          {state.error && <div className="notice err mt-2">{state.error}</div>}
          {state.ok && <div className="notice ok mt-2">{state.ok}</div>}
        </>
      }
    />
  );
}
