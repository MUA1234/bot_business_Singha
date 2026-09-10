/**
 * Per-domain resolution rules — exhaustive, and honest about the eleven domains that have none.
 *
 * A rule may only exist where the domain can say, deterministically, what "resolved" means for the
 * condition it raises. Writing one for a domain that cannot is how a system starts reporting
 * success it has not observed.
 *
 * ── Why operations is the first slice ────────────────────────────────────────────────────────
 *
 * Not because it is easy. Because its condition is a TARGETED re-read of one record, and the
 * resolution rule can be the detector itself run again. That removes the usual failure mode where
 * a verification rule drifts from the detection rule and starts disagreeing about what the problem
 * was: here they cannot disagree, because they are the same function.
 */
import { detectTaskExceptions, type TaskLike } from "@/management/ai-manager/exceptions";
import { isTerminal, type TaskState } from "@/modules/work/task-lifecycle";
import type { Department } from "../types";
import { result, type SourceRead, type VerificationResult } from "./contract";

/** Severity ordering, for deciding whether a condition got worse rather than better. */
const SEVERITY_RANK: Record<string, number> = { critical: 0, warn: 1, info: 2 };

/**
 * A domain rule re-reads the originating record and says what it found.
 *
 * `row === null` from a SUCCESSFUL read means the record is gone. That is deliberately NOT treated
 * as resolution: a deleted task and a completed task are indistinguishable from the outside, and
 * the owner's instruction is explicit that ambiguous deletion must refuse.
 */
/**
 * What a targeted re-read of a task returns.
 *
 * `requiresEvidence` and `verifiedEvidenceCount` are read from the record itself, not from
 * anyone's report of it — see the terminal-status rule below for why they matter.
 */
export interface TaskUnderVerification extends TaskLike {
  readonly requiresEvidence: boolean;
  /** Evidence rows a human actually verified. Self-attached, unverified evidence does not count. */
  readonly verifiedEvidenceCount: number;
}

export interface DomainRule {
  readonly domain: Department;
  /** The table this rule re-reads. Guards against an item pointed at something else. */
  readonly subjectTable: string;
  verify(input: {
    kind: string;
    read: SourceRead<TaskUnderVerification>;
    now: Date;
  }): VerificationResult;
}

const OPERATIONS_RULE: DomainRule = {
  domain: "operations",
  subjectTable: "tasks",
  verify({ kind, read, now }) {
    if (!read.ok) {
      // The read failed. "We could not look" is not "there is nothing there".
      return result("unavailable", `the originating record could not be read: ${read.reason}`);
    }
    if (read.row === null) {
      // Ambiguous by construction: the work may have been done and the row archived, or the row
      // may have been deleted by someone with no view of the condition at all.
      return result("unavailable", "the originating record no longer exists — deletion is ambiguous");
    }

    const task = read.row;

    // ── A terminal status is a CLAIM before it is a resolution ──────────────────────────────
    //
    // `detectOperationsObservations` filters terminal tasks out before it looks, so a completed
    // task cannot raise this condition again. That much is a re-read of the record's own state.
    //
    // But the owner's contract is explicit that "a user clicked complete" is not proof, and a
    // terminal status is exactly what that click produces. The record itself carries the
    // distinction: a task that DEMANDS evidence and has none verified was closed on somebody's
    // word alone, and that is a claim being tested, not the test.
    //
    // So: terminal AND (no evidence required OR evidence actually verified) ⇒ resolved.
    // Terminal AND evidence required AND none verified ⇒ `contradicted` — the claim and the
    // record's own requirement disagree, and a person has to look.
    if (isTerminal(task.status as TaskState)) {
      if (task.requiresEvidence && task.verifiedEvidenceCount < 1) {
        return result(
          "contradicted",
          "the task was closed as complete but requires evidence, and none is verified",
          "reopened",
        );
      }
      return result(
        "verified_resolved",
        `the originating task reached the terminal status "${task.status}"`,
        "verified",
      );
    }

    // Otherwise run the DETECTOR again. The verification rule cannot drift from the detection
    // rule, because it is the detection rule.
    const stillRaised = detectTaskExceptions([task], now);
    const same = stillRaised.find((e) => e.type === kind);
    if (same) {
      return result("condition_persists", `the "${kind}" condition is still present`, "reopened");
    }

    // Gone — but is something worse there instead? Being `due_soon` and becoming `overdue` is not
    // a resolution, and reporting it as one would be the most misleading answer available.
    const originalRank = SEVERITY_RANK[severityOf(kind)] ?? 2;
    const worse = stillRaised.find((e) => (SEVERITY_RANK[e.severity] ?? 2) < originalRank);
    if (worse) {
      return result(
        "condition_worsened",
        `"${kind}" is gone but "${worse.type}" is now present and more severe`,
        "reopened",
      );
    }

    return result("verified_resolved", `the "${kind}" condition is no longer raised`, "verified");
  },
};

/** The severity the detector assigns each exception type. Mirrors `exceptions.ts`. */
function severityOf(kind: string): string {
  switch (kind) {
    case "escalated":
    case "overdue":
      return "critical";
    case "blocked":
    case "due_soon":
    case "stale_check_in":
      return "warn";
    default:
      return "info";
  }
}

/**
 * Every domain, listed. Eleven are `null` — they have no rule, and the verifier says so rather
 * than inventing one.
 *
 * Listing them explicitly rather than defaulting means adding a domain forces a decision about
 * how, or whether, its conditions can be verified.
 */
const RULES: Record<Department, DomainRule | null> = {
  operations: OPERATIONS_RULE,
  // No targeted re-read rule yet. Each needs a domain decision about what "resolved" means, and
  // for several of them absence is NOT meaningful — an invoice that stops being returned by a
  // query may have been paid, written off, re-dated, or simply missed by a partial sweep.
  finance: null,
  workforce: null,
  crm: null,
  system: null,
  governance: null,
  objectives: null,
  marketing: null,
  procurement: null,
  assets: null,
  legal: null,
  providers: null,
};

export function ruleFor(department: string): DomainRule | null {
  if (!Object.hasOwn(RULES, department)) return null;
  return RULES[department as Department] ?? null;
}

/** The domains that can currently verify an outcome. Derived, never restated. */
export function verifiableDomains(): Department[] {
  return (Object.keys(RULES) as Department[]).filter((d) => RULES[d] !== null);
}
