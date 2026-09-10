/**
 * The storage port for outcome verification.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────────────────────
 *
 * Verification had exactly one implementation and it spoke raw SQL, so the only way to run it was
 * with a direct PostgreSQL connection. `makeCycleDeps` speaks through the Supabase query builder,
 * could not supply that, and therefore did not supply the dependency at all — which the cycle
 * treated as "no verification configured" and reported as zeroes. A deployment could run for ever
 * verifying nothing while every summary said the cycle completed calmly.
 *
 * The fix is NOT a second verification implementation. It is this port: one set of rules, one
 * scheduler, one service, and two ways of reaching a database. Everything below is transport —
 * fetching rows and writing rows. No detector runs here, no outcome is decided here, no lifecycle
 * transition is chosen here, and no backoff is computed here. Those live in `rules.ts`,
 * `verify.ts`, `service.ts` and `schedule.ts`, once each, and both adapters go through them.
 *
 * The two adapters are checked against each other by a live parity test: the same fixtures, the
 * same conclusions. An adapter that quietly disagreed would be the duplicated-logic failure this
 * port exists to prevent.
 */
import type { SourceRead } from "./contract";
import type { TaskUnderVerification } from "./rules";
import type { VerificationOutcome } from "./contract";

/** An item awaiting verification, with its schedule state. */
export interface PendingVerification {
  readonly itemId: string;
  readonly attempts: number;
  /**
   * When this item may next be attempted, or `null` for "never attempted, due now".
   *
   * Null rather than the current time deliberately. The SQL adapter used to substitute the
   * DATABASE's `now()` here while the scheduler compared it against the APPLICATION's clock, so a
   * never-attempted item could be deferred by nothing but clock skew between two machines.
   */
  readonly nextAttemptAt: Date | null;
}

/** The item's own row, as verification needs it. The evidence generation is fetched separately. */
export interface ItemRow {
  readonly id: string;
  readonly companyId: string;
  readonly department: string;
  readonly kind: string;
  readonly subjectTable: string;
  readonly subjectId: string;
  readonly state: string;
  /** The transition INTO a claimed state — when completion was reported. */
  readonly claimedAt: Date | null;
}

/** One verification attempt, already decided. The store only writes it down. */
export interface AttemptRecord {
  readonly companyId: string;
  readonly itemId: string;
  readonly attemptNo: number;
  readonly outcome: VerificationOutcome;
  readonly detail: string;
  readonly observedAt: Date;
  readonly generation: string;
  /** Computed by the scheduler from the single backoff rule, not by the adapter. */
  readonly nextAttemptAt: Date;
  readonly attemptedAt: Date;
}

export interface TransitionRequest {
  readonly itemId: string;
  readonly from: string;
  readonly to: string;
  readonly actorId: string | null;
  readonly actorType: "user" | "system" | "ai";
  readonly detail: string;
}

export interface VerificationStore {
  /** Which transport this is. Reported in summaries so a run says how it reached the database. */
  readonly transport: "postgres" | "supabase";

  /**
   * Every item of this company awaiting verification, whether or not it is due.
   *
   * Unordered: the scheduler applies the single ordering rule. Two adapters sorting for themselves
   * is exactly how fairness would come to depend on which transport a deployment happened to use.
   */
  listPending(companyId: string): Promise<PendingVerification[]>;

  loadItem(companyId: string, itemId: string): Promise<ItemRow | null>;

  /**
   * Re-read the originating task.
   *
   * A thrown error must become `{ ok: false }` — "we could not look" — and a missing row
   * `{ ok: true, row: null }` — "it is not there". The rule treats those differently and must be
   * able to, so an adapter may never collapse them.
   */
  readTask(companyId: string, taskId: string): Promise<SourceRead<TaskUnderVerification>>;

  /** The content digest of the item's evidence, from the same function every boundary uses. */
  evidenceGeneration(companyId: string, itemId: string): Promise<string>;

  /** Apply a lifecycle transition through the database boundary. Returns whether it moved. */
  transition(companyId: string, req: TransitionRequest): Promise<boolean>;

  /** Append the attempt and move the schedule forward. */
  recordAttempt(a: AttemptRecord): Promise<void>;
}
