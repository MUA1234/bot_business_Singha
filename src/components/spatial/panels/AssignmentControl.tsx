"use client";

/**
 * "Assign this work" — and every truthful state in which that is not what to show.
 *
 * ── What the wording must never imply ────────────────────────────────────────────────────────
 *
 * The system RECOMMENDS. It does not assign. So the recommended person is offered as a suggestion
 * with the evidence behind it, and choosing anyone else is permitted — it just has to be explained,
 * because "the manager knew better" is only reviewable if it was written down.
 *
 * Nothing here says the work is under way. An assignment means one thing: this person is now
 * accountable and the task is theirs. Whether they do it, and whether the original problem goes
 * away, are two further questions with their own boundaries.
 *
 * ── Why the control is so rarely shown, and why that is not the boundary ─────────────────────
 *
 * It renders only when the server resolved the state to `assignable`: a task exists, nobody has it,
 * the item is at a stage that admits an assignment, and this person holds `operations.task.manage`
 * right now. Every one of those is re-checked inside the database transaction, so a stale page or a
 * permission removed after load produces a refusal rather than an assignment.
 */

import { useState, useTransition } from "react";
import {
  assignManagementItem,
  type AssignmentInput,
} from "@/app/app/_actions/task-assignment";
import {
  assignmentMessage,
  assignmentStateMessage,
  type AssignmentState,
} from "@/app/app/_actions/assignment-messages";

/** One person the server offered, with the evidence that put them forward. */
export interface AssignmentCandidate {
  membershipId: string;
  label: string;
  /** 1 means "considered first". It is not a score. */
  rank: number | null;
  /** The eligibility digest recorded for this candidate, compared by the server. */
  eligibilityDigest: string | null;
  /** Why the resolver put them forward, in its own words. */
  reasons: string[];
}

export interface AssignmentControlProps {
  itemId: string;
  state: AssignmentState;
  seenState: string;
  seenConditionDigest: string;
  /** Ranked candidates, best first. Empty is a real answer: nobody could be recommended. */
  candidates: AssignmentCandidate[];
  /** Who holds it now, when somebody does. */
  assignedToLabel: string | null;
}

export default function AssignmentControl(props: AssignmentControlProps) {
  const recommended = props.candidates[0] ?? null;
  const [chosen, setChosen] = useState<string>(recommended?.membershipId ?? "");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "error">("ok");
  const [pending, startTransition] = useTransition();

  const selectId = `mq-assignee-${props.itemId}`;
  const reasonId = `mq-assign-reason-${props.itemId}`;
  const line = assignmentStateMessage(props.state);

  // Choosing anyone but the top-ranked candidate — or anyone at all when nobody was ranked — is an
  // override, and the server will require a reason for it. Saying so BEFORE the click is the
  // difference between a control that guides and one that just refuses.
  const isOverride = recommended === null || chosen !== recommended.membershipId;

  if (props.state !== "assignable") {
    return (
      <p className="muted" data-testid="mq-assignment-state" data-state={props.state}>
        {line}
        {props.state === "assigned" && props.assignedToLabel ? <> {props.assignedToLabel}.</> : null}
      </p>
    );
  }

  function submit() {
    if (!chosen) return;
    setMessage(null);
    startTransition(async () => {
      const candidate = props.candidates.find((c) => c.membershipId === chosen) ?? null;
      const input: AssignmentInput = {
        itemId: props.itemId,
        membershipId: chosen,
        seenState: props.seenState,
        seenConditionDigest: props.seenConditionDigest,
        // The digest recorded for THIS candidate. Null when nobody recommended them, which is what
        // makes it an override.
        seenEligibilityDigest: candidate?.eligibilityDigest ?? null,
        overrideReason: reason.trim() || null,
        // One key per mounted control and target, so a double-click is a retry of the SAME
        // assignment. The same key naming a different person is refused by the server.
        idempotencyKey: `${props.itemId}:${chosen}:assign`,
      };
      const out = await assignManagementItem(input);
      if (out.ok) {
        setTone("ok");
        setMessage(
          out.result === "duplicate"
            ? "Already assigned."
            : out.isOverride
              ? "Assigned, and recorded as a change from the recommendation."
              : "Assigned.",
        );
      } else {
        setTone("error");
        setMessage(assignmentMessage(out.refusal));
      }
    });
  }

  return (
    <div className="mq-actions stack gap-1" data-testid="mq-assignment" data-state={props.state}>
      <p className="muted" data-testid="mq-assignment-state" data-state={props.state}>{line}</p>

      {props.candidates.length === 0 ? (
        <p className="muted" data-testid="mq-no-candidates">
          Nobody could be recommended for this. You can still assign someone — say why below.
        </p>
      ) : (
        <>
          <label className="t-label" htmlFor={selectId}>
            Assign to
          </label>
          <select
            id={selectId}
            className="input"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            disabled={pending}
            data-testid="mq-assignee-select"
          >
            {props.candidates.map((c) => (
              <option key={c.membershipId} value={c.membershipId}>
                {c.label}
                {c.rank === 1 ? " — recommended" : ""}
              </option>
            ))}
          </select>

          {/* The evidence behind the suggestion. A recommendation a manager cannot interrogate is
              one they can only accept or ignore. */}
          {recommended && recommended.reasons.length > 0 && (
            <details className="mq-candidate-why">
              <summary className="mq-touch-target">Why this person</summary>
              <ul data-testid="mq-candidate-reasons">
                {recommended.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}

      <label className="t-label" htmlFor={reasonId}>
        Reason {isOverride ? "(required — this differs from the recommendation)" : "(optional)"}
      </label>
      <textarea
        id={reasonId}
        className="input"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={pending}
      />

      <button
        type="button"
        className="btn mq-touch-target"
        data-testid="mq-assign"
        disabled={pending || !chosen || (isOverride && reason.trim() === "")}
        onClick={submit}
      >
        Assign
      </button>

      {/* Announced to assistive technology: an assignment that silently succeeded or silently
          failed is the same experience for someone who cannot see the panel repaint. */}
      <p
        role="status"
        aria-live="polite"
        className={tone === "error" ? "error" : "muted"}
        data-testid="mq-assignment-status"
      >
        {pending ? "Assigning…" : (message ?? "")}
      </p>

      <span className="muted" data-testid="mq-assignment-caveat">
        Assigning makes this person accountable and gives them the task. It does not start the work,
        and it does not say the problem is solved.
      </span>
    </div>
  );
}
