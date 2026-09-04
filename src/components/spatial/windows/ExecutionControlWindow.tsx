"use client";

/**
 * R2E — the execution control window.
 *
 * What an operator needs from this screen is not a list of buttons. It is an answer to one
 * question: *can this system do anything to my company right now, and what has it done?*
 *
 * So the state of both boundaries is the first thing on the page, stated plainly, and the answer
 * today is no. There is deliberately no "execute" or "enable" control anywhere in this window —
 * the global boundary is a compile-time constant and per-company enablement is an administrative
 * database decision, so a button here would either be a lie or a second way in.
 *
 * The policy table is shown in full rather than filtered to the interesting rows, because
 * "13 of these 15 can only ever produce a draft" is the reassurance, and hiding the draft-only
 * rows would remove it.
 */

import { useMemo, useState } from "react";
import type { WindowContentProps } from "../types";

export interface ExecutionPolicyRow {
  actionId: string;
  classification: "prohibited" | "draft_only" | "locally_executable";
  authorityFloor: string;
  handler: string | null;
  rationale: string;
}

export interface ExecutionAttemptRow {
  id: string;
  actionId: string;
  status: "attempting" | "executed" | "refused" | "failed";
  refusalReason: string | null;
  effectRef: string | null;
  createdAt: string;
}

export interface ExecutionControlProps extends Partial<WindowContentProps> {
  globallyEnabled: boolean;
  companyEnabled: boolean;
  policies: ExecutionPolicyRow[];
  attempts: ExecutionAttemptRow[];
}

/** Plain words. "locally_executable" is a code identifier, not something to show a person. */
const CLASSIFICATION_LABEL: Record<ExecutionPolicyRow["classification"], string> = {
  prohibited: "Never runs",
  draft_only: "Drafts only",
  locally_executable: "Can run, with approval",
};

const STATUS_LABEL: Record<ExecutionAttemptRow["status"], string> = {
  attempting: "In progress",
  executed: "Done",
  refused: "Refused",
  failed: "Failed",
};

export default function ExecutionControlWindow(props: ExecutionControlProps) {
  const { globallyEnabled, companyEnabled, policies, attempts } = props;
  const [showAll, setShowAll] = useState(false);

  const canActAtAll = globallyEnabled && companyEnabled;

  const counts = useMemo(() => {
    const c = { prohibited: 0, draft_only: 0, locally_executable: 0 };
    for (const p of policies) c[p.classification]++;
    return c;
  }, [policies]);

  const visible = showAll ? policies : policies.filter((p) => p.classification !== "draft_only");

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto p-4 text-sm">
      {/* ── The answer to the only question that matters, first and unambiguous. ── */}
      <section
        aria-labelledby="exec-state-heading"
        className={`rounded-lg border p-3 ${
          canActAtAll
            ? "border-amber-400 bg-amber-50 dark:border-amber-600 dark:bg-amber-950"
            : "border-emerald-400 bg-emerald-50 dark:border-emerald-700 dark:bg-emerald-950"
        }`}
      >
        <h3 id="exec-state-heading" className="font-semibold">
          {canActAtAll
            ? "This system can make changes for this company"
            : "This system cannot make any change"}
        </h3>
        <p className="mt-1 opacity-80">
          Both switches must be on before anything can happen. They are separate on purpose:
          agreeing to be observed is not agreeing to be acted upon.
        </p>
        <ul className="mt-2 space-y-1" role="list">
          <li>
            <span aria-hidden="true">{globallyEnabled ? "●" : "○"}</span>{" "}
            <strong>System-wide:</strong>{" "}
            {globallyEnabled ? "on" : "off — built into this release, not a setting"}
          </li>
          <li>
            <span aria-hidden="true">{companyEnabled ? "●" : "○"}</span>{" "}
            <strong>This company:</strong>{" "}
            {companyEnabled ? "enabled" : "not enabled"}
          </li>
        </ul>
      </section>

      {/* ── What the system is permitted to do at all, per action. ── */}
      <section aria-labelledby="exec-policy-heading">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 id="exec-policy-heading" className="font-semibold">
            What each action is allowed to do
          </h3>
          <p className="opacity-70">
            {counts.locally_executable} can run · {counts.draft_only} draft only ·{" "}
            {counts.prohibited} never
          </p>
        </div>

        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          aria-expanded={showAll}
          className="mt-2 rounded border px-2 py-1 text-xs"
        >
          {showAll ? "Hide draft-only actions" : `Show all ${policies.length} actions`}
        </button>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] border-collapse text-left">
            <caption className="sr-only">
              Every registered action and what the system may do with it
            </caption>
            <thead>
              <tr className="border-b">
                <th scope="col" className="py-1 pr-3 font-medium">Action</th>
                <th scope="col" className="py-1 pr-3 font-medium">May</th>
                <th scope="col" className="py-1 font-medium">Needs</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((p) => (
                <tr key={p.actionId} className="border-b align-top last:border-0">
                  <th scope="row" className="py-1 pr-3 font-mono text-xs font-normal">
                    {p.actionId}
                  </th>
                  <td className="py-1 pr-3">{CLASSIFICATION_LABEL[p.classification]}</td>
                  <td className="py-1">{p.authorityFloor.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── What it actually did. Refusals included: they are the majority and the reassurance. ── */}
      <section aria-labelledby="exec-attempts-heading">
        <h3 id="exec-attempts-heading" className="font-semibold">
          Recent attempts
        </h3>
        {attempts.length === 0 ? (
          <p className="mt-1 opacity-70">Nothing has been attempted for this company.</p>
        ) : (
          <ul className="mt-2 space-y-2" role="list">
            {attempts.map((a) => (
              <li key={a.id} className="rounded border p-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-mono text-xs">{a.actionId}</span>
                  <span className="text-xs opacity-70">{STATUS_LABEL[a.status]}</span>
                </div>
                {a.refusalReason ? (
                  <p className="mt-1 text-xs opacity-80">
                    Refused: {a.refusalReason.replace(/_/g, " ")}
                  </p>
                ) : null}
                {a.effectRef ? (
                  <p className="mt-1 text-xs opacity-80">Created: {a.effectRef}</p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="opacity-70">
        Nothing on this screen turns execution on. The system-wide switch is part of the released
        build, and enabling a company is an administrative change recorded against the person who
        makes it.
      </p>
    </div>
  );
}
