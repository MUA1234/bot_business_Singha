"use client";

import { useActionState } from "react";
import Link from "next/link";
import { analyzeUpdate, type AnalyzeState } from "./actions";

/**
 * Paste a business update → the Senior AI Manager observes it, captures follow-up
 * tasks, and flags what needs human approval. It proposes; it never executes.
 */
export function AnalyzeForm() {
  const [state, formAction, pending] = useActionState<AnalyzeState, FormData>(analyzeUpdate, {});
  const r = state.result;

  return (
    <div className="stack gap-3">
      <div className="card">
        <form action={formAction} className="stack gap-2">
          <textarea name="update" className="textarea" style={{ minHeight: 120 }}
            placeholder="Paste a business update — e.g. a WhatsApp message, a site report, an email…" />
          <button className="btn" type="submit" disabled={pending}>{pending ? "Analysing…" : "Analyse"}</button>
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

          {r.needsApproval && (
            <div className="notice err">⚠️ This involves actions above routine authority — routed for human approval. Nothing was executed.</div>
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
