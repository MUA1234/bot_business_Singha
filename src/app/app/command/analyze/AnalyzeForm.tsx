"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import { analyzeUpdate, type AnalyzeState } from "./actions";

/** Submit button that reflects the pending state (React 18 idiom). */
function SubmitButton() {
  const { pending } = useFormStatus();
  return <button className="btn" type="submit" disabled={pending}>{pending ? "Analysing…" : "Analyse"}</button>;
}

/**
 * Paste a business update → the business analysis assistant observes it, captures follow-up
 * tasks, and flags what needs human approval. It proposes; it never executes.
 */
export function AnalyzeForm() {
  const [state, formAction] = useFormState<AnalyzeState, FormData>(analyzeUpdate, {});
  const r = state.result;

  return (
    <div className="stack gap-3">
      <div className="card">
        <form action={formAction} className="stack gap-2">
          <textarea name="update" className="textarea" style={{ minHeight: 120 }}
            placeholder="Paste a business update — e.g. a WhatsApp message, a site report, an email…" />
          <SubmitButton />
        </form>
        {state.error && <div className="notice err mt-2">{state.error}</div>}
      </div>

      {r && (
        <>
          <div className="grid cols-3">
            <div className="card stat"><div className="k">Tasks captured</div><div className="v" style={{ fontSize: "1.6rem", color: "var(--ok)" }}>{r.createdTasks}</div></div>
            <div className="card stat"><div className="k">Confidence</div><div className="v" style={{ fontSize: "1.6rem" }}>{Math.round(r.confidence * 100)}%</div></div>
            <div className="card stat"><div className="k">Authority</div><div className="v" style={{ fontSize: "1.1rem" }}>{r.requiredAuthority.replace(/_/g, " ")}</div></div>
          </div>

          {/* AIM-003 — report the DURABLE routing state. This used to say "routed for human
              approval" when no request, queue, recipient or record existed. A notice is not
              routing; the counts below come from task_routing rows that actually exist. */}
          {r.createdTasks > 0 && (
            <div className={`notice ${r.routing.failed > 0 ? "err" : "ok"}`}>
              {Object.entries(r.routing.byState).map(([state, n]) => (
                <div key={state}>
                  {n} task{n === 1 ? "" : "s"}: <strong>{state.replace(/_/g, " ")}</strong>
                  {state === "needs_routing" && " — captured, not yet assigned to anyone"}
                  {state === "manual_review" && " — above routine authority; a person must decide"}
                </div>
              ))}
              {r.routing.failed > 0 && (
                <div>
                  ⚠️ {r.routing.failed} task{r.routing.failed === 1 ? "" : "s"} could not be given a routing state.
                  The work was saved but is currently unrouted.
                </div>
              )}
              {r.routing.routed === 0 && r.routing.failed === 0 && (
                <div>⚠️ No routing state was recorded for the captured work.</div>
              )}
              <div className="small mt-1">Nothing was executed and no one was notified.</div>
            </div>
          )}

          {/* AIM-002 — the analysis proposed work that already exists. Saying nothing here would
              read as "the assistant found nothing", which is a different and untrue statement. */}
          {r.deduplicatedTasks > 0 && (
            <div className="notice">
              {r.deduplicatedTasks} proposed task{r.deduplicatedTasks === 1 ? " was" : "s were"} already
              captured under the same identity and {r.deduplicatedTasks === 1 ? "was" : "were"} not created again.
              {r.createdTasks === 0 && " Nothing new was captured from this update."}
            </div>
          )}

          {r.needsApproval && (
            <div className="notice err">
              ⚠️ This involves actions above routine authority. There is no approval queue yet, so it
              is held for manual review rather than sent to an approver.
            </div>
          )}

          {r.confirmedFacts.length > 0 && (
            <div className="card">
              <div className="card-title">Confirmed facts</div>
              <ul className="mt-2" style={{ paddingLeft: 18 }}>{r.confirmedFacts.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          {r.suggestedActions.length > 0 && (
            <div className="card">
              <div className="card-title">Suggested actions <span className="dim small">(for you to decide — not auto-run)</span></div>
              <ul className="mt-2" style={{ paddingLeft: 18 }}>{r.suggestedActions.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          {r.clarifications.length > 0 && (
            <div className="card">
              <div className="card-title">Missing information</div>
              <ul className="mt-2" style={{ paddingLeft: 18 }}>{r.clarifications.map((f, i) => <li key={i}>{f}</li>)}</ul>
            </div>
          )}
          {r.createdTasks > 0 && (
            <p className="muted small">Captured tasks are in <Link href="/app/operations/tasks">Operations → Tasks</Link>.</p>
          )}
        </>
      )}
    </div>
  );
}
