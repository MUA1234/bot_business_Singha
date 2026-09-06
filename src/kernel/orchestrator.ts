/**
 * The lifecycle orchestrator: the ONE place that decides what happens to an item next.
 *
 * ── Why this exists (R2F-F-014) ──────────────────────────────────────────────────────────────
 *
 * Four spans of the management lifecycle had no writer at all. The cycle created an item in
 * `observed` and nothing ever moved it, so the decision boundary, the completion claim and outcome
 * verification were three correct mechanisms with nothing to operate on. An item filed by the
 * deployed system stayed `observed` for ever.
 *
 * The fix is deliberately NOT a set of state writes sprinkled through the cycle. It is one service
 * with one decision function, so "what may happen to an item now" has a single answer that can be
 * read, tested and argued with. Every write still goes through `r1_draft_transition_item()`, which
 * re-locks the item, re-checks the from-state and appends history — so the orchestrator cannot
 * invent a transition the database does not already permit.
 *
 * ── The authority separation this encodes ────────────────────────────────────────────────────
 *
 * The owner's decision is explicit about who may do what, and the split is visible in the code:
 *
 *   SYSTEM       observe, prioritise, recommend, request approval, execute the one authorised
 *                automatic action, monitor, schedule verification, re-observe.
 *   HUMAN        approve, reject, assign, reassign, override with a reason, reopen, escalate.
 *   STAFF        claim their own completion.
 *   VERIFIER     record a deterministic outcome, as a service actor.
 *
 * So `decideNext` never returns `approved` for an item that needs a person, never returns
 * `assigned`, and never returns `verified`. Those transitions belong to other boundaries and are
 * unreachable from here — not by convention, but because this function cannot express them.
 *
 * PURE decision, injected effects. `decideNext` has no clock, no database and no randomness.
 */
import { ACTION_CATALOGUE } from "./catalogue";
import { resolveCanonicalAuthority } from "./execution/authority";
import { classificationFor } from "./execution/policy";
import type { ItemState } from "./lifecycle";
import { canTransition } from "./lifecycle";

/** The one action the owner authorised as potentially automatic. */
const AUTOMATIC_ACTION_ID = "ops.task.create_internal";

/** What the orchestrator needs to know about an item. Every field comes from its own row. */
export interface OrchestratableItem {
  readonly id: string;
  readonly companyId: string;
  readonly state: ItemState;
  readonly actionId: string | null;
  readonly requiredAuthority: string | null;
  readonly mayRunUnattended: boolean;
  readonly evidenceCount: number;
  /** Whether a plan was recorded with the recommendation. No plan ⇒ nothing to execute. */
  readonly hasPlan: boolean;
  /** True once an execution attempt for this item reached `executed`. */
  readonly effectCreated: boolean;
  /** The membership named accountable, or null. Set only by a real binding assignment. */
  readonly accountableOwnerId: string | null;
  /** The linked task's assignee, or null. */
  readonly taskAssignee: string | null;
  /** The user behind `accountableOwnerId`, or null. */
  readonly accountableUserId: string | null;
}

/**
 * What the orchestrator decided.
 *
 * `hold` is a first-class outcome and the most important one: an item that cannot legitimately
 * move must stay where it is WITH A REASON, not be nudged forward so the queue looks busy.
 */
export type LifecycleDecision =
  | { readonly kind: "transition"; readonly to: ItemState; readonly reason: string }
  | { readonly kind: "execute"; readonly reason: string }
  | { readonly kind: "hold"; readonly reason: string }
  | { readonly kind: "awaiting_human"; readonly reason: string };

/** Is this item's action genuinely automatic — all six facts agreeing, not one flag? */
export function isAutomaticItem(item: OrchestratableItem): boolean {
  if (item.actionId !== AUTOMATIC_ACTION_ID) return false;
  if (item.requiredAuthority !== "automatic") return false;
  if (!item.mayRunUnattended) return false;
  const canonical = resolveCanonicalAuthority(item.actionId);
  return canonical.automatic && !canonical.failedClosed;
}

/** Is the proposed action registered, and does the policy allow an effect at all? */
function actionIsUsable(actionId: string | null): boolean {
  if (!actionId) return false;
  if (!ACTION_CATALOGUE.some((a) => a.id === actionId)) return false;
  return classificationFor(actionId) !== "prohibited";
}

/**
 * The next legal step for one item, from its current state and its own validated facts.
 *
 * Every returned transition is checked against the SAME map the database enforces, so a decision
 * this function makes and a decision the database refuses cannot diverge silently.
 */
export function decideNext(item: OrchestratableItem): LifecycleDecision {
  const legal = (to: ItemState, reason: string): LifecycleDecision =>
    canTransition(item.state, to)
      ? { kind: "transition", to, reason }
      : { kind: "hold", reason: `the lifecycle does not permit ${item.state} → ${to}` };

  switch (item.state) {
    // ── Observation and understanding ────────────────────────────────────────────────────
    case "observed":
      if (item.evidenceCount < 1) {
        // The zero-evidence prohibition, stated where it bites rather than discovered later.
        return { kind: "hold", reason: "the item holds no evidence" };
      }
      return legal("understood", "evidence is attached and the observation is intelligible");

    case "understood":
      return legal("prioritised", "priority resolved by the deterministic rules");

    // ── Recommendation ───────────────────────────────────────────────────────────────────
    case "prioritised":
      if (!actionIsUsable(item.actionId)) {
        // Visibly unavailable, and it STAYS visible. Advancing an item whose action can never run
        // would put it in a queue of things somebody is waiting on.
        return {
          kind: "hold",
          reason: item.actionId
            ? `no usable action: ${item.actionId} is unregistered or prohibited`
            : "no action has been proposed for this item",
        };
      }
      return legal("recommended", `a catalogue action is proposed: ${item.actionId}`);

    case "recommended": {
      // R2F-F-020, stated where it bites. In practice this branch is always taken for a
      // cycle-created item: `authorityFor` supplies `actorMembershipId: null` — correctly, because
      // the cycle proposes and never approves — and the authority engine escalates a null actor
      // membership to `manager_approval` and fails closed. So no item the cycle files can resolve
      // to `automatic`, and the one action the owner authorised as automatic never takes its
      // automatic path.
      //
      // Not repaired here. Lowering an authority the engine raised would be weakening an authority
      // control to make a test pass, and the correct path — a person approves, then the system
      // carries out the action it is registered to carry out — is real, reachable and proven.
      if (!isAutomaticItem(item)) {
        return legal(
          "awaiting_approval",
          `this action requires ${item.requiredAuthority ?? "an authority that could not be resolved"}`,
        );
      }
      if (!item.hasPlan) {
        // Automatic and unplanned is not automatic. Without a recorded plan there is nothing the
        // execution would have been authorised against.
        return { kind: "hold", reason: "no plan was recorded with the recommendation" };
      }
      return legal("approved", "the canonical policy resolves this action to automatic authority");
    }

    // ── The authorised effect, then honest routing ───────────────────────────────────────
    //
    // Whether the authorisation came from the automatic policy or from a person, the system may
    // carry out the ONE action the owner registered as executable. It does not decide that it is
    // authorised: the executor re-checks both boundaries, the policy, the authority, the approval
    // record and every freshness digest, and refuses if any of them disagrees. Deciding here would
    // be a second authority check beside the real one, and the laxer of two paths is the one that
    // eventually gets used.
    case "approved":
      if (!item.effectCreated && item.actionId === AUTOMATIC_ACTION_ID && item.hasPlan) {
        return {
          kind: "execute",
          reason: isAutomaticItem(item)
            ? "authorised automatically; the effect has not been created"
            : "approved; the effect has not been created",
        };
      }
      if (!item.effectCreated) {
        // Approved, for an action the system has no handler for. A person carries it out.
        return { kind: "awaiting_human", reason: "approved; the action is not one the system performs" };
      }
      // The effect exists and NOBODY is assigned. That is what `needs_routing` means, and saying
      // `assigned` here would be the system asserting an assignment it is not allowed to make.
      return legal("needs_routing", "the task was created unassigned and needs a human to route it");

    case "needs_routing":
      // Binding assignment is a human act with its own boundary. The orchestrator waits.
      return { kind: "awaiting_human", reason: "a manager must assign this work" };

    case "awaiting_approval":
      return { kind: "awaiting_human", reason: "a manager or owner must approve or reject this" };

    // ── Monitoring ───────────────────────────────────────────────────────────────────────
    case "assigned": {
      if (!item.accountableOwnerId || !item.taskAssignee) {
        return { kind: "hold", reason: "assigned without both an accountable owner and a task assignee" };
      }
      if (item.accountableUserId !== item.taskAssignee) {
        // An explicit failure, never a silent repair. The item says one person is accountable and
        // the task says another is doing it; guessing which is right would make the record worse.
        return {
          kind: "hold",
          reason: "the accountable owner and the task assignee are different people",
        };
      }
      return legal("monitoring", "assigned work is now being monitored");
    }

    // ── Everything else belongs to another boundary ──────────────────────────────────────
    case "monitoring":
      return { kind: "awaiting_human", reason: "the assignee reports completion when their work is done" };
    case "escalated":
      return { kind: "awaiting_human", reason: "escalated; a manager decides what happens next" };
    case "verifying":
      return { kind: "hold", reason: "outcome verification owns this item" };
    case "reopened":
      return { kind: "awaiting_human", reason: "reopened; a manager re-prioritises or reassigns" };
    case "verified":
    case "rejected":
    case "dismissed":
    case "expired":
      return { kind: "hold", reason: "terminal" };
  }
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// The sweep.
// ─────────────────────────────────────────────────────────────────────────────────────────

export interface OrchestratorDeps {
  now(): Date;
  /** Every open item of one company, with the facts `decideNext` needs. Company-scoped. */
  loadOpen(companyId: string): Promise<OrchestratableItem[]>;
  /** Through `r1_draft_transition_item()`. Returns false when the database refused. */
  transition(input: {
    companyId: string;
    itemId: string;
    from: ItemState;
    to: ItemState;
    reason: string;
    correlationId: string;
  }): Promise<boolean>;
  /** The real execution service. Returns the outcome verbatim. */
  execute(input: { companyId: string; itemId: string }): Promise<{ executed: boolean; detail: string }>;
}

export interface LifecycleSweepSummary {
  considered: number;
  advanced: number;
  executed: number;
  /** Waiting on a person. Not a failure and not progress. */
  awaitingHuman: number;
  /** Could not legitimately move, with a reason recorded per item. */
  held: number;
  /** The database refused a transition this decided — a real disagreement, reported. */
  refused: number;
  failed: number;
  /** True when any item was left in an unknown position. */
  partial: boolean;
  /** Per-item reasons, bounded, for the cycle summary and the operator. */
  notes: Array<{ itemId: string; outcome: string; reason: string }>;
}

export const emptyLifecycleSummary = (): LifecycleSweepSummary => ({
  considered: 0, advanced: 0, executed: 0, awaitingHuman: 0, held: 0, refused: 0, failed: 0,
  partial: false, notes: [],
});

/**
 * How many items one company may be advanced in one cycle.
 *
 * Bounded for the same reason verification is: the twelve domain reads must still happen, and a
 * backlog must work through over cycles rather than starving observation once.
 */
export const LIFECYCLE_BUDGET_PER_CYCLE = 25;

/** At most this many notes are carried in a summary; the rest are counted, never invented. */
const MAX_NOTES = 50;

/**
 * Advance the open items of one company by at most ONE step each.
 *
 * One step, deliberately. Driving an item from `observed` to `approved` in a single pass would
 * collapse five distinct decisions into one indistinguishable moment, and the history is what a
 * person later uses to ask why something happened. Each step is its own transition row with its own
 * reason and its own timestamp.
 */
export async function runLifecycleSweep(
  deps: OrchestratorDeps,
  input: { companyId: string; correlationId: string; budget?: number },
): Promise<LifecycleSweepSummary> {
  const summary = emptyLifecycleSummary();
  const budget = input.budget ?? LIFECYCLE_BUDGET_PER_CYCLE;

  let items: OrchestratableItem[];
  try {
    items = await deps.loadOpen(input.companyId);
  } catch (e) {
    summary.failed = 1;
    summary.partial = true;
    summary.notes.push({ itemId: "-", outcome: "load_failed", reason: (e as Error).message });
    return summary;
  }

  summary.considered = items.length;
  const note = (itemId: string, outcome: string, reason: string) => {
    if (summary.notes.length < MAX_NOTES) summary.notes.push({ itemId, outcome, reason });
  };

  let used = 0;
  for (const item of items) {
    if (used >= budget) {
      summary.partial = true;
      break;
    }

    const decision = decideNext(item);
    used++;

    try {
      switch (decision.kind) {
        case "hold":
          summary.held++;
          note(item.id, "held", decision.reason);
          break;

        case "awaiting_human":
          summary.awaitingHuman++;
          note(item.id, "awaiting_human", decision.reason);
          break;

        case "execute": {
          const out = await deps.execute({ companyId: item.companyId, itemId: item.id });
          if (out.executed) {
            summary.executed++;
            note(item.id, "executed", out.detail);
          } else {
            // A refusal is the executor working. It is reported, and the item stays where it is
            // so the next cycle can try again once whatever refused it has changed.
            summary.held++;
            summary.partial = true;
            note(item.id, "execution_refused", out.detail);
          }
          break;
        }

        case "transition": {
          const moved = await deps.transition({
            companyId: item.companyId,
            itemId: item.id,
            from: item.state,
            to: decision.to,
            reason: decision.reason,
            correlationId: input.correlationId,
          });
          if (moved) {
            summary.advanced++;
            note(item.id, `→ ${decision.to}`, decision.reason);
          } else {
            // The database saw a different from-state: something else moved this item under us.
            // Reported as a disagreement, never retried in a loop.
            summary.refused++;
            summary.partial = true;
            note(item.id, "transition_refused", `${item.state} → ${decision.to}`);
          }
          break;
        }
      }
    } catch (e) {
      // One item's failure must not stop the others, and must never advance them.
      summary.failed++;
      summary.partial = true;
      note(item.id, "failed", (e as Error).message);
    }
  }

  return summary;
}
