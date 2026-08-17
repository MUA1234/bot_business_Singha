/**
 * Durable inbound sweeper (migration 0069).
 *
 * This is the executable path that makes "retry" a fact rather than a claim. The verification
 * campaign had to retract exactly that claim: an inbound message whose processing failed was never
 * retried, because the webhook acknowledges 200 regardless and no sweeper existed.
 *
 * Contract:
 *   - claims a leased batch atomically (`claim_source_events` — FOR UPDATE SKIP LOCKED);
 *   - hands each row to a processor;
 *   - reports the outcome truthfully: success completes the row, failure applies bounded backoff or
 *     dead-letters it once attempts are exhausted;
 *   - a thrown processor is a failure, never a silent success;
 *   - counts are returned so the caller can report partial failure and remaining backlog instead of
 *     a bare "ok".
 *
 * Fairness is a property of the CLAIM, not of this loop: a failed row's `next_attempt_at` moves
 * into the future, so it stops competing for slots and later work proceeds.
 */
import { log } from "@/lib/log";

export interface SweepableEvent {
  id: string;
  company_id: string | null;
  source: string | null;
  attempts: number | null;
}

/** Outcome of processing one event. `retryable: false` dead-letters immediately. */
export type ProcessOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string; retryable?: boolean };

export interface SweepDeps {
  claim(limit: number, owner: string, leaseSeconds: number): Promise<SweepableEvent[]>;
  complete(id: string, owner: string): Promise<void>;
  fail(id: string, owner: string, code: string, message: string, maxAttempts: number): Promise<string>;
  process(event: SweepableEvent): Promise<ProcessOutcome>;
}

export interface SweepResult {
  claimed: number;
  completed: number;
  retryScheduled: number;
  deadLettered: number;
  /** True when at least one row did not complete — the caller must not report a clean sweep. */
  partialFailure: boolean;
}

export interface SweepOptions {
  limit?: number;
  owner: string;
  leaseSeconds?: number;
  maxAttempts?: number;
}

export async function sweepInbound(deps: SweepDeps, opts: SweepOptions): Promise<SweepResult> {
  const limit = opts.limit ?? 25;
  const leaseSeconds = opts.leaseSeconds ?? 120;
  const maxAttempts = opts.maxAttempts ?? 5;

  const batch = await deps.claim(limit, opts.owner, leaseSeconds);
  const result: SweepResult = {
    claimed: batch.length,
    completed: 0,
    retryScheduled: 0,
    deadLettered: 0,
    partialFailure: false,
  };

  for (const event of batch) {
    let outcome: ProcessOutcome;
    try {
      outcome = await deps.process(event);
    } catch (e) {
      // A processor that throws is a FAILURE. Treating it as anything else is how the campaign's
      // "analysed but never persisted" class of bug happens.
      outcome = { ok: false, code: "processor_threw", message: (e as Error).message };
    }

    if (outcome.ok) {
      try {
        await deps.complete(event.id, opts.owner);
        result.completed++;
      } catch (e) {
        // The work succeeded but we could not record it. The lease will expire and the row will be
        // retried; processing must therefore be idempotent. Report it, never swallow it.
        result.partialFailure = true;
        log("error", "inbound sweeper could not record completion", {
          event: "inbound.complete_failed",
          sourceEventId: event.id,
          error: (e as Error).message,
        });
      }
      continue;
    }

    // A non-retryable failure exhausts its attempts immediately rather than burning the schedule.
    const attempts = outcome.retryable === false ? 1 : maxAttempts;
    try {
      const state = await deps.fail(event.id, opts.owner, outcome.code, outcome.message, attempts);
      if (state === "dead_letter") result.deadLettered++;
      else result.retryScheduled++;
    } catch (e) {
      result.partialFailure = true;
      log("error", "inbound sweeper could not record failure", {
        event: "inbound.fail_record_failed",
        sourceEventId: event.id,
        error: (e as Error).message,
      });
    }
    result.partialFailure = true;
  }

  return result;
}
