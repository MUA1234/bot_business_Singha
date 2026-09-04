"use client";

/**
 * The real, connected Approve / Reject controls.
 *
 * ── What they replace ────────────────────────────────────────────────────────────────────────
 *
 * Two `<a href="/app/command/queue/{id}/accept">` links to routes that do not exist. The queue
 * offered a person a decision and led them to a 404 (R2-F-015). A control that cannot do the thing
 * it names is worse than no control: it teaches people that the system is broken, and it hides the
 * fact that nothing was recorded.
 *
 * ── Why the four `seen*` values are submitted ────────────────────────────────────────────────
 *
 * They describe the screen this person decided from — the item state, the canonical action, the
 * evidence digest and the parameter digest. The server COMPARES them and refuses if any has moved.
 * Without them a decision made against a five-minute-old page would be applied to whatever the item
 * has since become, which is not what the person agreed to.
 *
 * They are not a trust mechanism. Nothing here can grant itself authority by sending different
 * values: sending the wrong ones produces a refusal, never a wider permission.
 */

import { useState, useTransition } from "react";
import {
  recordManagementDecision,
  decisionMessage,
  type DecisionInput,
} from "@/app/app/_actions/management-decision";

export interface DecisionControlsProps {
  itemId: string;
  seenState: string;
  seenActionId: string | null;
  seenEvidenceDigest: string;
  seenParameterDigest: string | null;
  /** Resolved on the SERVER from the real capability. Absent means no. */
  mayDecide: boolean;
  /** True when the proposed action has no executable handler. */
  approvedWouldBeUnavailable?: boolean;
}

export default function DecisionControls(props: DecisionControlsProps) {
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "error">("ok");
  const [pending, startTransition] = useTransition();
  const reasonId = `mq-reason-${props.itemId}`;
  const statusId = `mq-decision-status-${props.itemId}`;

  if (!props.mayDecide) {
    return (
      <p className="muted" data-testid="mq-no-decision-rights">
        You can see this recommendation but may not decide it. Someone with approval permission in
        this company can approve or reject it.
      </p>
    );
  }

  function submit(decision: "approve" | "reject") {
    setMessage(null);
    startTransition(async () => {
      const input: DecisionInput = {
        itemId: props.itemId,
        decision,
        seenState: props.seenState,
        seenActionId: props.seenActionId,
        seenEvidenceDigest: props.seenEvidenceDigest,
        seenParameterDigest: props.seenParameterDigest,
        reason: reason.trim() || null,
        // One key per mounted control, so a double-click is a retry of the SAME decision rather
        // than a second one. A different decision under the same key is refused by the server.
        idempotencyKey: `${props.itemId}:${decision}`,
      };
      const out = await recordManagementDecision(input);
      if (out.ok) {
        setTone("ok");
        setMessage(
          out.result === "duplicate"
            ? "Already recorded."
            : decision === "approve"
              ? props.approvedWouldBeUnavailable
                ? "Approved. There is no automated handler for this action, so someone has to carry it out."
                : "Approved. Nothing has been carried out yet — execution is a separate step."
              : "Rejected.",
        );
      } else {
        setTone("error");
        setMessage(decisionMessage(out.refusal));
      }
    });
  }

  return (
    <div className="mq-actions stack gap-1">
      <label className="t-label" htmlFor={reasonId}>
        Reason (required to reject)
      </label>
      <textarea
        id={reasonId}
        className="input"
        rows={2}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        disabled={pending}
      />

      <div className="row gap-1">
        <button
          type="button"
          className="btn mq-touch-target"
          data-testid="mq-approve"
          disabled={pending}
          onClick={() => submit("approve")}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn mq-touch-target"
          data-testid="mq-reject"
          disabled={pending || reason.trim() === ""}
          onClick={() => submit("reject")}
        >
          Reject
        </button>
      </div>

      {/* Announced to assistive technology: a decision that silently succeeded or silently failed
          is the same experience for someone who cannot see the panel repaint. */}
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        className={tone === "error" ? "error" : "muted"}
        data-testid="mq-decision-status"
      >
        {pending ? "Recording…" : (message ?? "")}
      </p>

      <span className="muted" data-testid="mq-human-decides">
        Approving records a decision. It does not carry the action out.
      </span>
    </div>
  );
}
