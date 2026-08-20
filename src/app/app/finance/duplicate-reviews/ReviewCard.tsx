"use client";

import { useActionState } from "react";
import { fmtMoney } from "@/lib/money";
import { resolveDuplicateReview, type ResolveState } from "./actions";

export interface ReviewItem {
  review_id: string;
  state: string;
  resolution: string | null;
  score: number | string;
  feature_contributions: Record<string, number> | null;
  evidence_present: string[] | null;
  evidence_missing: string[] | null;
  algorithm_version: string;
  created_at: string | Date;
  resolved_by: string | null;
  resolved_by_name: string | null;
  resolved_at: string | Date | null;
  resolution_note: string | null;
  candidate_event_id: string;
  candidate_amount: string | number | null;
  candidate_currency: string | null;
  candidate_date: string | Date | null;
  candidate_counterparty: string | null;
  candidate_state: string;
  candidate_purpose: string | null;
  candidate_source_event_id: string | null;
  matched_event_id: string;
  matched_amount: string | number | null;
  matched_currency: string | null;
  matched_date: string | Date | null;
  matched_counterparty: string | null;
  matched_state: string;
  matched_purpose: string | null;
}

const pct = (n: unknown) => `${Math.round(Number(n ?? 0) * 100)}%`;

/**
 * A transaction date, as a plain YYYY-MM-DD string.
 *
 * The value arrives as a string over Supabase's HTTP API but as a `Date` from a direct PostgreSQL
 * driver, and React throws outright on a Date child. Normalising here means the card renders the
 * same words whichever way the row reached it — and it is the reason this component can be
 * asserted against real persisted rows at all.
 */
const day = (d: string | Date | null | undefined): string => {
  if (!d) return "—";
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
};

/** A timestamp, as `YYYY-MM-DD HH:MM`. Same reasoning as `day`. */
const stamp = (d: string | Date | null | undefined): string => {
  if (!d) return "";
  const t = d instanceof Date ? d : new Date(String(d));
  return Number.isNaN(t.getTime()) ? "" : t.toISOString().slice(0, 16).replace("T", " ");
};

function Side({
  title, amount, currency, date, counterparty, state, purpose, eventId,
}: {
  title: string; amount: string | number | null; currency: string | null; date: string | Date | null;
  counterparty: string | null; state: string; purpose: string | null; eventId: string;
}) {
  return (
    <div className="card p-3" data-testid={`dup-side-${title.toLowerCase().replace(/\s+/g, "-")}`}>
      <div className="muted text-xs uppercase">{title}</div>
      <div className="text-lg mt-1" data-testid="dup-amount">
        {amount != null ? fmtMoney(amount, currency ?? undefined) : "—"}
      </div>
      <dl className="mt-2 text-sm stack gap-1">
        <div><dt className="muted inline">Date </dt><dd className="inline" data-testid="dup-date">{day(date)}</dd></div>
        <div><dt className="muted inline">Counterparty </dt><dd className="inline" data-testid="dup-counterparty">{counterparty ?? "—"}</dd></div>
        <div><dt className="muted inline">Purpose </dt><dd className="inline">{purpose ?? "—"}</dd></div>
        <div><dt className="muted inline">State </dt><dd className="inline" data-testid="dup-state">{state}</dd></div>
        <div><dt className="muted inline">Event </dt><dd className="inline"><code className="text-xs">{eventId}</code></dd></div>
      </dl>
    </div>
  );
}

/**
 * The presentational half — no hooks, so it can be rendered on the server and asserted against the
 * rows the RPC actually persisted (tests/integration/of016-rendered-matches-persisted.test.tsx).
 * The interactive form lives in `ReviewCard` below and is passed in as `children`, which keeps the
 * words a reviewer reads testable independently of the action that submits them.
 */
export function ReviewCardView({ item, children }: { item: ReviewItem; children?: React.ReactNode }) {
  const resolved = item.state === "resolved";
  const contributions = item.feature_contributions ?? {};

  return (
    <li className="card p-4 stack gap-3" data-testid="duplicate-review" data-review-id={item.review_id}>
      <div className="row items-center justify-between gap-2 flex-wrap">
        <h3 className="m-0">
          Suspected duplicate · score <span data-testid="dup-score">{pct(item.score)}</span>
        </h3>
        <span className={resolved ? "badge" : "badge warn"} data-testid="dup-status">
          {resolved ? `Resolved — ${item.resolution === "confirmed_duplicate" ? "duplicate" : "distinct"}` : "Awaiting a decision"}
        </span>
      </div>

      {/* The single most important sentence on this screen. */}
      <div className="notice" data-testid="dup-caveat">
        This is a <strong>suspected</strong> duplicate raised by a similarity score — not proven
        fraud and not a verdict. The payment below is paused and reversible; nothing has been
        discarded. Decide from the evidence, not from the number.
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <Side title="This payment" amount={item.candidate_amount} currency={item.candidate_currency}
          date={item.candidate_date} counterparty={item.candidate_counterparty}
          state={item.candidate_state} purpose={item.candidate_purpose} eventId={item.candidate_event_id} />
        <Side title="Earlier payment" amount={item.matched_amount} currency={item.matched_currency}
          date={item.matched_date} counterparty={item.matched_counterparty}
          state={item.matched_state} purpose={item.matched_purpose} eventId={item.matched_event_id} />
      </div>

      <details className="card p-3" data-testid="dup-evidence">
        <summary>Why this was raised</summary>
        <div className="stack gap-2 mt-2 text-sm">
          <div>
            <span className="muted">Per-feature contribution: </span>
            {Object.keys(contributions).length === 0
              ? "—"
              : Object.entries(contributions).map(([k, v]) => (
                  <span key={k} className="badge mr-1" data-testid={`dup-contrib-${k}`}>{k} {pct(v)}</span>
                ))}
          </div>
          <div>
            <span className="muted">Evidence present: </span>
            {(item.evidence_present ?? []).length ? (item.evidence_present ?? []).join(", ") : "none"}
          </div>
          <div data-testid="dup-missing">
            <span className="muted">Evidence missing: </span>
            {(item.evidence_missing ?? []).length ? (item.evidence_missing ?? []).join(", ") : "none"}
            {(item.evidence_missing ?? []).length > 0 && (
              <span className="muted"> — missing evidence contributed nothing to the score.</span>
            )}
          </div>
          <div><span className="muted">Rule version: </span><code>{item.algorithm_version}</code></div>
          <div><span className="muted">Raised: </span>{stamp(item.created_at)}</div>
        </div>
      </details>

      {resolved ? (
        <div className="notice" data-testid="dup-resolution-history">
          Resolved as <strong>{item.resolution === "confirmed_duplicate" ? "a duplicate" : "a distinct transaction"}</strong>
          {item.resolved_by_name ? <> by {item.resolved_by_name}</> : null}
          {item.resolved_at ? <> on {stamp(item.resolved_at)}</> : null}.
          {item.resolution_note ? <> Reason: “{item.resolution_note}”</> : null}
          <div className="muted mt-1">A terminal decision is immutable. Correcting one is a separate, audited process.</div>
        </div>
      ) : (
        children
      )}
    </li>
  );
}

export function ReviewCard({ item }: { item: ReviewItem }) {
  const [state, action, pending] = useActionState<ResolveState, FormData>(resolveDuplicateReview, {});
  if (item.state === "resolved") return <ReviewCardView item={item} />;
  return (
    <ReviewCardView item={item}>
      <form action={action} className="stack gap-2" data-testid="dup-form">
          <input type="hidden" name="reviewId" value={item.review_id} />
          <label className="stack gap-1">
            <span>Reason <span className="muted">(required — it is recorded in the audit trail)</span></span>
            <input name="reason" required maxLength={500} data-testid="dup-reason"
              placeholder="e.g. second genuine invoice from the same supplier, different PO" />
          </label>
          <div className="row gap-2 flex-wrap">
            <button type="submit" name="resolution" value="dismissed_distinct"
              disabled={pending} data-testid="dup-mark-distinct">
              {pending ? "Recording…" : "These are different transactions"}
            </button>
            <button type="submit" name="resolution" value="confirmed_duplicate"
              className="danger" disabled={pending} data-testid="dup-confirm">
              {pending ? "Recording…" : "Confirm it is a duplicate"}
            </button>
          </div>
          {state.error && <div className="notice err" data-testid="dup-error">{state.error}</div>}
          {state.conflict && <div className="notice warn" data-testid="dup-conflict">{state.conflict}</div>}
        {state.ok && <div className="notice ok" data-testid="dup-ok">{state.ok}</div>}
      </form>
    </ReviewCardView>
  );
}
