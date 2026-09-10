/**
 * Scheduled inbound dispatch drain (remediation R1 §3, OF-001).
 *
 * WHY IT EXISTS. A dispatch that failed — a review row that could not be queued, an unmapped
 * receiving number, a handler that threw — was recovered only by the provider redelivering the
 * message. That is not a retry mechanism: it is bounded by how long Meta happens to keep trying,
 * it does nothing at all for a receipt whose backoff outlives the redelivery window, and it does
 * not exist for a channel with no redelivery. `claim_inbound_dispatch_batch` was built in migration
 * 0076 and had no caller. This is the caller.
 *
 * Pure orchestration over ports, so the ordering, deadline, concurrency and outcome accounting are
 * testable without a database, a scheduler or a provider.
 *
 * WHAT IT GUARANTEES
 *   * bounded batch, bounded concurrency, bounded wall-clock;
 *   * the lease decides ownership — two overlapping runs cannot process the same receipt;
 *   * work still unstarted when the deadline arrives is RELEASED, not failed: the attempt is given
 *     back, so a drain that runs long cannot dead-letter healthy work;
 *   * outcomes are counted by KIND, and a run that could not finish says so rather than reporting a
 *     clean sweep.
 */
import { log } from "@/lib/log";

/** One receipt as the claim returns it. */
export interface DrainableReceipt {
  id: string;
  /** Which channel produced this receipt. Decides WHICH adapter re-reads its stored payload. */
  source: string;
  provider_message_id: string | null;
  provider_account_id: string | null;
  raw_payload: unknown;
  correlation_id: string | null;
  dispatch_attempts: number | null;
}

/** What happened to one receipt. Mirrors the dispatch orchestration's own result vocabulary. */
export type DrainOutcome =
  | "customer_order" | "staff_finance" | "manual_review" | "recorded" | "clarification"
  | "no_provider_message_id" | "already_dispatched" | "retry_pending" | "unattributed" | "error"
  | "released_deadline";

export interface DrainDeps {
  /** `claim_inbound_dispatch_batch` — leases a bounded batch in one statement. */
  claim(limit: number, owner: string, leaseSeconds: number): Promise<DrainableReceipt[]>;
  /** Run the SAME orchestration the webhook runs, on an already-leased receipt. */
  dispatch(receipt: DrainableReceipt, owner: string): Promise<DrainOutcome>;
  /** Hand a leased receipt back, uncharged, when the deadline arrives first. */
  release(id: string, owner: string): Promise<void>;
  /** Monotonic clock, injected so deadline behaviour is deterministic in tests. */
  now(): number;
}

export interface DrainOptions {
  owner: string;
  limit?: number;
  leaseSeconds?: number;
  /** Wall-clock ceiling for the whole run, well inside the platform's function timeout. */
  deadlineMs?: number;
  /** How many receipts may be in flight at once. */
  concurrency?: number;
}

export interface DrainResult {
  claimed: number;
  /** Count per outcome kind — the truthful record of what the run did. */
  byOutcome: Record<string, number>;
  /** Claimed but never started because the deadline arrived; handed back uncharged. */
  released: number;
  /** A receipt whose dispatch threw AND whose failure could not be recorded. */
  errors: number;
  /** True when the run did not finish its batch, or could not record an outcome. */
  partial: boolean;
  durationMs: number;
}

export async function drainInboundDispatch(deps: DrainDeps, opts: DrainOptions): Promise<DrainResult> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 200);
  const leaseSeconds = opts.leaseSeconds ?? 120;
  const deadlineMs = opts.deadlineMs ?? 45_000;
  const concurrency = Math.min(Math.max(opts.concurrency ?? 4, 1), 16);
  const started = deps.now();
  const deadline = started + deadlineMs;

  const result: DrainResult = {
    claimed: 0, byOutcome: {}, released: 0, errors: 0, partial: false, durationMs: 0,
  };

  let batch: DrainableReceipt[];
  try {
    batch = await deps.claim(limit, opts.owner, leaseSeconds);
  } catch (e) {
    // Nothing was claimed, so nothing is stranded. Report the failure rather than an empty sweep.
    log("error", "dispatch drain could not claim a batch", {
      event: "dispatch.claim_failed", owner: opts.owner, error: (e as Error).message,
    });
    result.partial = true;
    result.durationMs = deps.now() - started;
    return result;
  }
  result.claimed = batch.length;

  // A shared cursor: each worker takes the next receipt, so a slow one cannot hold up the others and
  // the deadline is checked per item rather than per slice.
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= batch.length) return;
      const receipt = batch[index]!;

      if (deps.now() >= deadline) {
        // Out of time. Hand it back UNCHARGED — the receipt did nothing wrong.
        try {
          await deps.release(receipt.id, opts.owner);
          result.released++;
          result.byOutcome.released_deadline = (result.byOutcome.released_deadline ?? 0) + 1;
        } catch (e) {
          // It stays leased until expiry, which the next run recovers. Say so; never claim success.
          result.errors++;
          log("error", "dispatch drain could not release a receipt at the deadline", {
            event: "dispatch.release_failed", sourceEventId: receipt.id, error: (e as Error).message,
          });
        }
        result.partial = true;
        continue;
      }

      try {
        const outcome = await deps.dispatch(receipt, opts.owner);
        result.byOutcome[outcome] = (result.byOutcome[outcome] ?? 0) + 1;
        // These are outstanding, not finished: the run must not report a clean sweep.
        if (outcome === "error" || outcome === "retry_pending" || outcome === "unattributed") {
          result.partial = true;
        }
      } catch (e) {
        // The orchestration records its own failures; reaching here means even that failed.
        result.errors++;
        result.partial = true;
        log("error", "dispatch drain: a receipt threw outside the orchestration", {
          event: "dispatch.item_threw", sourceEventId: receipt.id, error: (e as Error).message,
        });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(batch.length, 1)) }, worker));

  result.durationMs = deps.now() - started;
  return result;
}
