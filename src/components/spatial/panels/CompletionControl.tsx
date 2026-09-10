"use client";

/**
 * "Report my work complete" — and every truthful state in which that is NOT what to show.
 *
 * ── What a claim means, on screen and off ────────────────────────────────────────────────────
 *
 * One thing: the assigned person reports that their work is complete. The wording never says
 * "done", "resolved" or "closed", because none of those has been established. What follows a claim
 * is a check, and the check may disagree.
 *
 * ── Why the button is so rarely shown, and why that is not the boundary ──────────────────────
 *
 * The control renders only when the server resolved the state to `claimable`: this signed-in person
 * is the current assignee of the linked task, the task is finished, the item is at a stage that
 * admits a claim, and the capability is held right now. Every one of those is re-checked inside the
 * database transaction, so a stale page, a removed permission or a reassigned task produces a
 * refusal rather than a claim. Hiding the button is a courtesy to the person, not a security
 * control — and the tests exercise the API directly to keep that distinction honest.
 */

import { useState, useTransition } from "react";
import {
  claimTaskCompletion,
  type CompletionClaimInput,
} from "@/app/app/_actions/task-completion";
import {
  completionMessage,
  completionStateMessage,
  type CompletionState,
} from "@/app/app/_actions/completion-messages";

export interface CompletionControlProps {
  itemId: string;
  /** The task this claim would be about, or null when nothing is linked. */
  taskId: string | null;
  /** Which of the two real relationships links the task to the item. */
  linkKind: "originating" | "effect" | null;
  state: CompletionState;
  seenState: string;
  seenActionId: string | null;
  seenEvidenceDigest: string;
  /** When the claim was made, for the states that follow one. */
  claimedAt: string | null;
}

export default function CompletionControl(props: CompletionControlProps) {
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "error">("ok");
  const [pending, startTransition] = useTransition();
  const noteId = `mq-completion-note-${props.itemId}`;

  const line = completionStateMessage(props.state);

  if (props.state !== "claimable") {
    return (
      <p
        className={
          props.state === "condition_persists" || props.state === "contradicted"
            ? "error"
            : "muted"
        }
        data-testid="mq-completion-state"
        data-state={props.state}
      >
        {line}
        {props.claimedAt && props.state === "claimed_awaiting_verification" ? (
          <> Reported {new Date(props.claimedAt).toLocaleString()}.</>
        ) : null}
      </p>
    );
  }

  function submit() {
    if (!props.taskId) return;
    setMessage(null);
    startTransition(async () => {
      const input: CompletionClaimInput = {
        itemId: props.itemId,
        taskId: props.taskId!,
        seenState: props.seenState,
        seenActionId: props.seenActionId,
        seenEvidenceDigest: props.seenEvidenceDigest,
        note: note.trim() || null,
        // One key per mounted control and task, so a double-click is a retry of the SAME claim
        // rather than a second one. The same key with a different task is refused by the server.
        idempotencyKey: `${props.itemId}:${props.taskId}:complete`,
      };
      const out = await claimTaskCompletion(input);
      if (out.ok) {
        setTone("ok");
        setMessage(
          out.result === "duplicate"
            ? "Already reported."
            : "Reported. Someone will check whether the original problem is resolved.",
        );
      } else {
        setTone("error");
        setMessage(completionMessage(out.refusal));
      }
    });
  }

  return (
    <div className="mq-actions stack gap-1" data-testid="mq-completion" data-state={props.state}>
      <p className="muted" data-testid="mq-completion-state" data-state={props.state}>
        {line}
        {props.linkKind === "effect"
          ? " This is the task created in response to the problem, not the problem itself."
          : null}
      </p>

      <label className="t-label" htmlFor={noteId}>
        Note (optional)
      </label>
      <textarea
        id={noteId}
        className="input"
        rows={2}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        disabled={pending}
      />

      <button
        type="button"
        className="btn mq-touch-target"
        data-testid="mq-claim-completion"
        disabled={pending}
        onClick={submit}
      >
        Report my work complete
      </button>

      {/* Announced to assistive technology: a claim that silently succeeded or silently failed is
          the same experience for someone who cannot see the panel repaint. */}
      <p
        role="status"
        aria-live="polite"
        className={tone === "error" ? "error" : "muted"}
        data-testid="mq-completion-status"
      >
        {pending ? "Recording…" : (message ?? "")}
      </p>

      <span className="muted" data-testid="mq-completion-caveat">
        This records that you say your work is finished. It does not close the item, and it does not
        say the original problem is resolved.
      </span>
    </div>
  );
}
