/**
 * The management cycle — R1's single server-side runtime entrypoint.
 *
 * ONE implementation, used by every trigger mode: an authorised manual invocation, an
 * internal test invocation, and a future scheduler that is defined but NOT registered. A
 * route must never contain a second management implementation.
 *
 * TWO INDEPENDENT SWITCHES, both required, both server-side:
 *   1. a global server flag (`MANAGEMENT_KERNEL`), default OFF, deliberately NOT prefixed
 *      `NEXT_PUBLIC_` so it can never be set or read from a browser;
 *   2. an explicit per-company enablement row, writable only with the existing
 *      `admin.organisation.manage` capability.
 * If either is absent or false the kernel does not scan, does not recommend, changes no
 * management state and WRITES NOTHING AT ALL — no run row, no audit event, no lock. It
 * returns a typed disabled result and logs to the server only. "Nothing looked" and
 * "nothing needed attention" stay distinguishable through that status, not through a
 * database write performed by a cycle that never ran.
 *
 * WHAT THE CYCLE NEVER DOES: send a message, move money, post a journal, approve a financial
 * event, contact a provider, take a customer-facing action, invoke a paid or live model, or
 * cross a company boundary. Those are structural, not conventions — the action catalogue is
 * internal-only, the interpreter is a deterministic fixture, and every query is
 * company-scoped.
 */
import { randomUUID } from "node:crypto";
import {
  emptySweepSummary,
  runVerificationSweep,
  type VerificationSweepSummary,
} from "./verification/schedule";
import { log } from "@/lib/log";
import {
  detectFinanceObservations, detectWorkforceObservations, detectOperationsObservations,
  detectCrmObservations, detectSystemHealthObservations,
  detectGovernanceObservations, detectObjectiveObservations, detectMarketingObservations,
  detectProcurementObservations, detectAssetObservations, detectLegalObservations,
  detectProviderObservations,
  FINANCE_SOURCE, WORKFORCE_SOURCE, OPERATIONS_SOURCE, CRM_SOURCE, SYSTEM_SOURCE,
  GOVERNANCE_SOURCE, OBJECTIVES_SOURCE, MARKETING_SOURCE, PROCUREMENT_SOURCE,
  ASSETS_SOURCE, LEGAL_SOURCE, PROVIDERS_SOURCE,
} from "./adapters";
import { ingestObservation, type ExistingItem, type IngestDecision } from "./ingest";
import { actionById } from "./catalogue";
import type { CandidateEvidence } from "./people/candidate";
import { resolveCandidates, type SignalLookup } from "./people/resolve";
import { requiredRolesFor, roleSpecOf, type ActionWithRoles, type RoleRequirement } from "./people/roles-required";
import { formTeam } from "./people/team";
import { buildSnapshots, RESOLVER_VERSION, type RecommendationSnapshot } from "./people/snapshot";
import { buildRecommendation } from "./recommend";
import { fixtureInterpreter, interpretWithGuards } from "./interpretation";
import type { Observation } from "./observation";
import type { Department } from "./types";
import type { AuthorityContext } from "@/policy/authority-engine";
import {
  type CursorProblem,
  rotate, RowBudget, PAGE_SIZE, PRIORITY_PAGE, RECONCILE_PAGE, CYCLE_ROW_BUDGET,
  reconcileSourceKey, rescanSourceKey, RESCAN_PAGE,
  validateCursorEnvelope, maxGenerationPages,
  type Cursor, type Page,
} from "./pagination";
import { isPagedSource, needsReconcileSweep, SOURCE_SPECS } from "./source-queries";

/** Cursor state as it is stored and returned. Position and counts only — never content. */
export interface StoredCursor {
  cursor: Cursor | null;
  generation: number;
  sweepCompleteAt: string | null;
  rowsInspected: number;
  pagesProcessed: number;
  pageFailures: number;
  status: "idle" | "in_progress" | "complete" | "failed" | "blocked";
}

export type TriggerMode = "manual" | "scheduled" | "test";

export type CycleStatus = "completed" | "partial" | "skipped_disabled" | "skipped_locked" | "failed";

export interface CycleSummary {
  correlationId: string;
  companyId: string;
  trigger: TriggerMode;
  status: CycleStatus;
  sourcesRegistered: number;
  sourcesSucceeded: number;
  sourcesFailed: number;
  itemsCreated: number;
  itemsReused: number;
  observationsSkipped: number;
  observationsRejected: number;
  /** Recommendation snapshot rows written this cycle (R2B). Advice, never assignment. */
  recommendationsRecorded: number;
  /** Items for which NOBODY was suitable, recorded truthfully rather than force-assigned. */
  itemsNeedingRouting: number;
  /** Departments whose adapter failed. A cycle with any of these can never be `completed`. */
  unobservedDepartments: Department[];
  /**
   * Sources whose read hit the row cap, so the domain was only PARTLY looked at. Never silent:
   * a truncated sweep cannot be reported as `completed`.
   */
  truncatedSources: string[];
  /**
   * What scheduled outcome verification did this cycle (R2F-F-009).
   *
   * Reported in full, including what it did NOT do: a cycle with verification work left unknown
   * can never be `completed`, for the same reason a truncated read cannot.
   */
  verification: VerificationSweepSummary;
  /**
   * Sources whose page was processed but whose POSITION could not be committed.
   *
   * The items are safe — they are persisted before the cursor is written. What is lost is the
   * record of progress, so the next cycle re-reads the same page, and if the cursor store
   * stays unavailable the sweep never advances. Reporting that as a clean cycle is the
   * silent-partial failure this kernel exists to avoid (R2S-P-F-003).
   */
  cursorCommitFailed: string[];

  // ── R2S-P: bounded paging, honestly reported. ──────────────────────────────────────────
  /** Rows actually inspected across every source this cycle. */
  recordsInspected: number;
  /** Pages read across every source this cycle. */
  pagesProcessed: number;
  /**
   * Sources with more to read, and where each resumes. A cycle carrying any of these is
   * `partial` with a continuation — never "all clear".
   */
  continuation: Array<{ source: string; generation: number; hasMore: boolean }>;
  /**
   * The periodic full sweep's progress, per source that has one.
   *
   * Reported so an operator can see that discovery does not rest on the overlap window, and
   * how far through its current generation each source is.
   */
  reconciliation: Array<{ source: string; generation: number; hasMore: boolean; inspected: number }>;
  /**
   * Rows reserved for reconciliation this cycle, exclusively.
   *
   * Incremental reads cannot draw on it, so this is the floor under the discovery bound.
   */
  reconcileReserve: number;
  /** Rows reserved for the earlier-range recovery rescan, exclusively. */
  rescanReserve: number;
  /**
   * Sources whose stored position could not be used and was abandoned to restart the sweep.
   *
   * Not a failure — the rows were read, from the beginning — but it means work was repeated
   * and a stored cursor was discarded, which an operator should be able to see.
   */
  cursorReset: string[];
  /**
   * Sources whose reconciliation generation ran too long and was abandoned unfinished.
   *
   * The sweep is making progress but cannot keep up with rows arriving BEHIND its fence —
   * backdated inserts. Discovery is delayed, not lost: the next generation restarts from the
   * beginning. It is reported because "still in progress" would suggest a pass that is going
   * to finish, and this one did not.
   */
  reconciliationDelayed: string[];
  /**
   * Why each reset happened — `source: problem-code`.
   *
   * A code, never the position's value: a cursor is small, but it is not a thing to print on
   * the way past.
   */
  cursorResetReasons: string[];
  /** True when the whole-cycle row budget stopped the sweep before every source was served. */
  budgetExhausted: boolean;
  /**
   * Whether a resolve-on-absence decision would be SAFE right now — true only when every source
   * completed a failure-free sweep this cycle.
   *
   * Nothing resolves items on absence today; this exists so that when it is built it cannot be
   * built unsafely. It is never a claim that resolution happened.
   */
  resolutionPermitted: boolean;
  failureReason: string | null;
  durationMs: number;
}

/** Everything the cycle needs, injected so it is testable and has no ambient I/O. */
export interface CycleDeps {
  /** Reads company-scoped source rows for one adapter. Throwing marks that source failed. */
  loadFor(source: string, companyId: string): Promise<unknown>;
  /**
   * Scheduled outcome verification (R2F-F-009). Optional: a deployment without the quarantined
   * verification schema simply does not verify, and the cycle reports zeroes rather than failing.
   *
   * Given `cycleComplete: false` it must defer everything — a partial cycle cannot support a
   * conclusion about whether a business condition was resolved.
   */
  verificationSweep?(input: {
    companyId: string;
    cycleComplete: boolean;
  }): Promise<VerificationSweepSummary>;
  /** True only when the per-company enablement row says so. */
  isCompanyEnabled(companyId: string): Promise<boolean>;
  /** Returns false when another cycle already holds this company's lock. */
  tryLock(companyId: string): Promise<boolean>;
  releaseLock(companyId: string): Promise<void>;
  /** Existing item for an identity key, or null. */
  findByIdentity(companyId: string, identityKey: string): Promise<ExistingItem | null>;
  /**
   * The same question for a WHOLE PAGE, in bounded chunks rather than one query per row.
   *
   * Measured on a 400-row fixture: one management cycle issued 494 identity lookups, 46% of
   * all its database work, to ask a question that fits in five queries. Chunking is
   * deterministic so the count is predictable and can be asserted rather than timed.
   *
   * Returns an EXACT key→item mapping. A key that is absent from the result genuinely has no
   * item; a failure THROWS rather than returning an empty map, because "the lookup failed"
   * and "there is nothing there" lead to opposite actions — the second would create a
   * duplicate of every item it could not see.
   */
  findExistingByIdentities?(req: IdentityLookupRequest): Promise<Map<string, ExistingItem>>;
  /** Persists item + evidence + opening transition in ONE transaction. */
  persist(
    o: Observation,
    rec: PersistRecommendation | null,
    snapshots?: readonly RecommendationSnapshot[],
  ): Promise<string>;
  /**
   * Candidate evidence for one company, built ENTIRELY from server-side reads (R2B, Decision 2).
   *
   * Optional: a deployment without it simply produces no candidate recommendation, which the
   * surface reports honestly. Throwing is treated as "evidence unavailable" and recorded as a
   * routing reason — never as "nobody is suitable", which is a different and much stronger claim.
   */
  loadCandidates?(companyId: string): Promise<readonly CandidateEvidence[]>;
  /** Verified outcome history for the same company, folded into a task-specific signal. */
  loadSignals?(companyId: string): Promise<SignalLookup>;
  /**
   * Read ONE bounded page of a source, resuming from `cursor` (R2S-P).
   *
   * Optional: a deployment without it falls back to `loadFor`, which is a single bounded read.
   * When present it replaces the 500-row cap with a cursored sweep, so every authorised record
   * is eventually observable while each cycle stays bounded.
   */
  loadPage?(req: PageRequest): Promise<Page<unknown>>;
  /**
   * The MOST OVERDUE rows for a source, read ahead of the sweep and never advancing its cursor.
   *
   * A keyset sweep by uuid is stable but arbitrary, so without this an ancient expired licence
   * could sit behind thousands of newer rows for several cycles.
   */
  loadPriority?(req: PriorityRequest): Promise<unknown>;
  /** Where each source's sweep left off. */
  readCursor?(ref: SourceRef): Promise<StoredCursor | null>;
  /**
   * Commit a page's position. Called ONLY after the page's items and evidence are persisted, so
   * a failure leaves the cursor where it was and the page is retried.
   */
  writeCursor?(ref: SourceRef, state: StoredCursor): Promise<void>;
  /**
   * One page of a source's periodic RECONCILIATION sweep, by primary key.
   *
   * The incremental cursor only ever moves forward through `updated_at`, so a row written
   * behind it — a backfill, an import, a skewed clock, a commit later than the overlap — would
   * never be read again. This sweep reaches every row regardless of its timestamp.
   */
  loadReconcile?(req: PageRequest): Promise<Page<unknown>>;
  /**
   * Sources whose read hit the row cap during this cycle (defect R2S-F-008).
   *
   * Every loader is a bounded full scan. A company with more rows than the cap in one domain was
   * having the remainder read as though it did not exist — a SILENT partial observation, which is
   * the same class of failure as a broken loader: the queue looks calm because the system did not
   * finish looking. Reported so the cycle can say so.
   */
  truncatedSources?(): readonly string[];
  /** Records the run. Called for cycles that actually RAN — never for a disabled one. */
  recordRun(summary: CycleSummary, actorId: string | null): Promise<void>;
  /** Company authority context for the existing authority engine. */
  authorityFor(companyId: string): Promise<AuthorityContext>;
  now(): Date;
}

/**
 * Which source, in which company.
 *
 * Both are strings, and they were adjacent positional parameters — in OPPOSITE orders in
 * neighbouring functions: `loadPage(source, companyId)` beside `readCursor(companyId,
 * source)`. A transposition type-checks perfectly and fails only at runtime, where it
 * surfaces as a missing column contract rather than as a swap. Exactly that mistake was
 * written and caught by hand while adding the reconciliation sweep; the next one would not
 * necessarily be caught.
 *
 * Naming them at the call site makes the mistake unrepresentable rather than merely unlikely.
 * `tests/kernel/cursor-identity.types.test.ts` fails to COMPILE if the positional form
 * returns.
 */
export interface SourceRef {
  source: string;
  companyId: string;
}

/**
 * Which reconciliation lane a read belongs to.
 *
 * The two lanes read the same table through the same function and differ only in their
 * cursor, which makes them indistinguishable to a caller — and that is not good enough for
 * evidence. A tail-liveness claim has to name the lane that reached the tail; without this
 * marker a test can assert "the sentinel was observed" and be satisfied by a different lane
 * entirely, which is exactly what happened before this was added.
 */
export type ReconcileLane = "forward" | "rescan";

/** One bounded page of a source, from a cursor. */
export interface PageRequest extends SourceRef {
  cursor: Cursor | null;
  limit: number;
  /** Set only for reconciliation reads; absent for the incremental sweep. */
  lane?: ReconcileLane;
}

/** The bounded priority pre-pass. */
export interface PriorityRequest extends SourceRef {
  limit: number;
}

/** Which identity keys to look up, in which company. */
export interface IdentityLookupRequest {
  companyId: string;
  identityKeys: readonly string[];
}

export interface PersistRecommendation {
  actionId: string;
  requiredAuthority: string;
  evidenceQuality: string;
  mayRunUnattended: boolean;
}

export interface CycleRequest {
  companyId: string;
  actorId: string | null;
  trigger: TriggerMode;
  /** Ties every item, transition and audit row of this cycle together. */
  correlationId?: string;
}

/** What one page of one source produced, and everything the cursor commit needs. */
interface PageOutcome {
  rows: unknown;
  inspected: number;
  pages: number;
  complete: boolean;
  next: Cursor | null;
  previousCursor: Cursor | null;
  generation: number;
  sweepCompleteAt: string | null;
  rowsInspectedTotal: number;
  pagesProcessedTotal: number;
  pageFailuresTotal: number;
  pageFailed: boolean;
  /** True when an unusable stored position was abandoned and the sweep restarted. */
  cursorWasReset: boolean;
  /** WHY it was unusable — a code, never the position's value. */
  cursorProblem: CursorProblem | null;
  /** The earlier-range rescan's outcome, when this source has one. */
  rescan: RescanOutcome | null;
  /** The reconciliation sweep's outcome for this source, when it has one. */
  reconcile: ReconcileOutcome | null;
}

interface RescanOutcome {
  inspected: number;
  complete: boolean;
  next: Cursor | null;
  generation: number;
}

interface ReconcileOutcome {
  inspected: number;
  complete: boolean;
  next: Cursor | null;
  previous: Cursor | null;
  /** True when this generation was restarted because its stored position was unusable. */
  wasReset: boolean;
  /** True when this generation ran too long and was abandoned unfinished. */
  delayed: boolean;
  /** True when this PASS was ever abandoned or restarted, so its wrap proves nothing. */
  dirty: boolean;
  generation: number;
  sweepCompleteAt: string | null;
  rowsInspectedTotal: number;
  pagesProcessedTotal: number;
}

/**
 * The sweep generation to rotate the visit order by.
 *
 * Read from any one source's stored state — the exact value does not matter, only that it
 * advances over time so the rotation moves and no source is starved for ever.
 */
async function seedGeneration(deps: CycleDeps, companyId: string): Promise<number> {
  try {
    const first = SOURCES[0];
    if (!first || !deps.readCursor) return 0;
    const state = await deps.readCursor({ companyId, source: first.source });
    return state?.generation ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Read one bounded page of a source, plus the priority pre-pass.
 *
 * The PRE-PASS reads the most overdue rows first and never advances the cursor, so an ancient
 * expired licence is surfaced promptly without disturbing stable pagination. Its rows are
 * combined with the page's; duplicates between them are absorbed by identity-key deduplication
 * in `ingest`, which is what that mechanism exists for.
 */
async function readOnePage(
  deps: CycleDeps,
  source: string,
  companyId: string,
  budget: RowBudget,
  reconcileBudget: RowBudget,
  rescanBudget: RowBudget | null,
): Promise<PageOutcome> {
  // An UNPAGED source (the system-health probe) is a bounded aggregate, not a row list: there
  // is nothing to page and no cursor to hold, so it is read whole through the ordinary loader
  // and reported as complete.
  if (!isPagedSource(source)) {
    const rows = await deps.loadFor(source, companyId);
    return {
      rows, inspected: 0, pages: 1, complete: true, next: null, previousCursor: null,
      generation: 0, sweepCompleteAt: null,
      rowsInspectedTotal: 0, pagesProcessedTotal: 0, pageFailuresTotal: 0, pageFailed: false,
      cursorWasReset: false, cursorProblem: null, reconcile: null, rescan: null,
    };
  }

  const stored = (await deps.readCursor?.({ companyId, source })) ?? null;
  const previousCursor = stored?.cursor ?? null;

  let cursorWasReset = false;
  let cursorProblem: CursorProblem | null = null;
  let rescan: RescanOutcome | null = null;
  const allowance = budget.allow(PAGE_SIZE);
  if (allowance === 0) {
    // The cycle budget is spent. This source is NOT read, its cursor does NOT move, and the
    // rotation will put it nearer the front next time.
    return {
      rows: [], inspected: 0, pages: 0, complete: false, next: previousCursor,
      previousCursor,
      generation: stored?.generation ?? 0,
      sweepCompleteAt: stored?.sweepCompleteAt ?? null,
      rowsInspectedTotal: stored?.rowsInspected ?? 0,
      pagesProcessedTotal: stored?.pagesProcessed ?? 0,
      pageFailuresTotal: stored?.pageFailures ?? 0,
      pageFailed: false,
      cursorWasReset: false, cursorProblem: null,
      reconcile: null, rescan: null,
    };
  }

  // The cursor is passed EXACTLY as stored. Rewinding it here (the original R2S-P-F-001
  // defect) reset the progress bound on every page, so a batch larger than one page was
  // re-read for ever and nothing past the first page was observed. The late-writer overlap
  // now lives inside the loader as a separate re-scan that cannot move the cursor.
  // A cursor whose SHAPE is unreadable is refused when it is read, and the sweep restarts.
  // This is the other half: a cursor that parses but cannot be USED — one written by a
  // different schema version, or corrupted, so the query itself is rejected. Left alone it
  // wedges the source permanently, and a source that can never read is a domain that can
  // never be observed, which is the failure this phase exists to prevent.
  //
  // So: restart from the beginning, ONCE. Re-reading is absorbed by identity-key
  // deduplication. If reading from the beginning fails too, the error is real and
  // propagates — this recovers from a bad POSITION, it does not swallow a broken source.
  let page: Page<unknown>;
  let resetFrom: Cursor | null = previousCursor;

  // The position is judged ON ITS OWN, before any source row is read, and that judgement is
  // the ONLY thing that can restart a sweep.
  //
  // It used to be inferred instead — from a retry that succeeded when reading from the
  // beginning. That is not evidence: a first page succeeding says nothing about a malformed
  // row on page nine, and a transient failure that clears on retry would be recorded as a
  // corrupt cursor. Once a position validates, every loader failure below belongs to the
  // SOURCE and is reported as one.
  const verdict = validateCursorEnvelope(
    previousCursor,
    SOURCE_SPECS[source]?.cursorKind ?? "none",
  );
  if (!verdict.ok) {
    resetFrom = null;
    cursorWasReset = true;
    cursorProblem = verdict.problem ?? null;
  }

  page = await deps.loadPage!({ source, companyId, cursor: resetFrom, limit: allowance });
  budget.spend(page.inspected);

  let rows: unknown = page.rows;
  let inspected = page.inspected;

  // The priority pre-pass. Bounded, cursor-free, and only where a source has a condition date.
  if (deps.loadPriority) {
    const priorityAllowance = budget.allow(PRIORITY_PAGE);
    if (priorityAllowance > 0) {
      try {
        const urgent = await deps.loadPriority({ source, companyId, limit: priorityAllowance });
        if (Array.isArray(urgent) && Array.isArray(page.rows)) {
          const seen = new Set((page.rows as Array<{ id?: unknown }>).map((r) => String(r?.id)));
          const extra = (urgent as Array<{ id?: unknown }>).filter((r) => !seen.has(String(r?.id)));
          rows = [...(page.rows as unknown[]), ...extra];
          inspected += extra.length;
          budget.spend(extra.length);
        }
      } catch {
        // The pre-pass is an accelerator, not a requirement. Losing it delays urgent rows to
        // their natural place in the sweep; it never loses them.
      }
    }
  }

  // ── The periodic reconciliation sweep. ──────────────────────────────────────────────
  //
  // Bounded like everything else, and it takes its rows from the SAME budget, so adding it
  // cannot make a cycle unbounded. If the budget is spent this source simply reconciles on a
  // later cycle; the rotation makes sure it is not the same source every time.
  let reconcile: ReconcileOutcome | null = null;
  if (deps.loadReconcile && needsReconcileSweep(source)) {
    const key = reconcileSourceKey(source);
    const storedRec = (await deps.readCursor?.({ companyId, source: key })) ?? null;
    const recAllowance = reconcileBudget.allow(RECONCILE_PAGE);
    if (recAllowance > 0) {
      // A generation that has not started yet gets its upper boundary NOW, and every page of
      // that generation carries the same one. Rows created later belong to the next
      // generation, so a steady insert rate cannot extend this one for ever.
      const startGeneration = (): Cursor => ({
        kind: "sweep_by_id", id: "", fence: deps.now().toISOString(),
      });

      let recFrom: Cursor | null = storedRec?.cursor ?? null;
      let recReset = false;
      const recVerdict = validateCursorEnvelope(recFrom, "sweep_by_id");
      if (!recVerdict.ok) {
        recFrom = null;
        recReset = true;
        cursorWasReset = true;
        cursorProblem = recVerdict.problem ?? null;
      }
      if (!recFrom) recFrom = startGeneration();

      // No retry, no reclassification: a validated position that then fails to read is a
      // source failure and is reported as one.
      const rp = await deps.loadReconcile({
        source, companyId, cursor: recFrom, limit: recAllowance, lane: "forward",
      });
      reconcileBudget.spend(rp.inspected);
      if (Array.isArray(rp.rows) && Array.isArray(rows)) {
        // Rows the incremental page already carried are not read twice in one cycle. A repeat
        // across cycles is harmless — identity-key deduplication absorbs it — but doing it
        // inside one cycle would just waste the budget.
        const seen = new Set((rows as Array<{ id?: unknown }>).map((r) => String(r?.id)));
        const fresh = (rp.rows as Array<{ id?: unknown }>).filter((r) => !seen.has(String(r?.id)));
        rows = [...(rows as unknown[]), ...fresh];
        inspected += rp.inspected;
      }
      // The work bound. A generation that has taken this many pages without finishing is
      // being fed backdated rows faster than it can sweep them; it is abandoned here and a
      // new one begins, rather than running for ever while the cycle reports "in progress".
      const pagesSoFar = (storedRec?.pagesProcessed ?? 0) + 1;
      const delayed = !rp.complete && pagesSoFar >= maxGenerationPages();
      // A pass that has ever been abandoned or restarted is DIRTY: it covered the table
      // under more than one boundary, so reaching the end does not mean it saw everything
      // once. It wraps without stamping completion, and a later clean pass earns that.
      const wasDirty = storedRec?.status === "blocked";

      // Abandoning refreshes the FENCE but KEEPS THE PLACE.
      //
      // Restarting at the first page here was a tail-starvation defect: with backdated rows
      // continually refilling the early pages, the sweep re-read the front of the table for
      // ever and a row near the end was never reached. Forward coverage must be monotonic —
      // that is the only thing that makes the tail reachable at all. Recovering rows that
      // land BEHIND this position is the rescan's job, below, not this one's.
      const refenced = (c: Cursor | null): Cursor =>
        c && c.kind === "sweep_by_id"
          ? { kind: "sweep_by_id", id: c.id, fence: deps.now().toISOString() }
          : startGeneration();

      reconcile = {
        inspected: rp.inspected,
        complete: rp.complete,
        delayed,
        next: delayed ? refenced(rp.next ?? recFrom) : rp.next,
        previous: recFrom,
        wasReset: recReset,
        dirty: wasDirty || delayed || recReset,
        generation: storedRec?.generation ?? 0,
        sweepCompleteAt: storedRec?.sweepCompleteAt ?? null,
        rowsInspectedTotal: storedRec?.rowsInspected ?? 0,
        pagesProcessedTotal: storedRec?.pagesProcessed ?? 0,
      };
    } else {
      // Not read this cycle. The position does not move and nothing claims completion.
      reconcile = {
        inspected: 0, complete: false, next: storedRec?.cursor ?? null,
        previous: storedRec?.cursor ?? null,
        wasReset: false, delayed: false, dirty: storedRec?.status === "blocked",
        generation: storedRec?.generation ?? 0,
        sweepCompleteAt: storedRec?.sweepCompleteAt ?? null,
        rowsInspectedTotal: storedRec?.rowsInspected ?? 0,
        pagesProcessedTotal: storedRec?.pagesProcessed ?? 0,
      };
    }
  }

  // ── The earlier-range rescan. ──────────────────────────────────────────────────────
  //
  // Forward coverage never goes back, so a row inserted BEHIND its position — a backdated
  // `created_at`, an import replaying history — would wait for a full wrap. This sweeps from
  // the beginning on its own cursor and its own budget, restarting whenever it finishes. It
  // is a recovery pass, not a coverage claim: it never sets completion and never licenses
  // resolution.
  if (deps.loadReconcile && needsReconcileSweep(source) && rescanBudget) {
    const rescanKey = rescanSourceKey(source);
    const storedRescan = (await deps.readCursor?.({ companyId, source: rescanKey })) ?? null;
    const allow = rescanBudget.allow(RESCAN_PAGE);
    if (allow > 0) {
      let from: Cursor | null = storedRescan?.cursor ?? null;
      if (!validateCursorEnvelope(from, "sweep_by_id").ok) from = null;
      if (!from) from = { kind: "sweep_by_id", id: "", fence: deps.now().toISOString() };

      const rs = await deps.loadReconcile({ source, companyId, cursor: from, limit: allow, lane: "rescan" });
      rescanBudget.spend(rs.inspected);
      if (Array.isArray(rs.rows) && Array.isArray(rows)) {
        const seen = new Set((rows as Array<{ id?: unknown }>).map((r) => String(r?.id)));
        const fresh = (rs.rows as Array<{ id?: unknown }>).filter((r) => !seen.has(String(r?.id)));
        rows = [...(rows as unknown[]), ...fresh];
        inspected += rs.inspected;
      }
      rescan = {
        inspected: rs.inspected,
        complete: rs.complete,
        // A finished rescan starts again from the beginning with a fresh boundary.
        next: rs.complete
          ? { kind: "sweep_by_id", id: "", fence: deps.now().toISOString() }
          : rs.next,
        generation: storedRescan?.generation ?? 0,
      };
    }
  }

  return {
    rows,
    inspected,
    pages: 1,
    rescan,
    complete: page.complete,
    next: page.next,
    previousCursor: resetFrom,
    cursorWasReset,
    cursorProblem,
    reconcile,
    generation: stored?.generation ?? 0,
    sweepCompleteAt: stored?.sweepCompleteAt ?? null,
    rowsInspectedTotal: stored?.rowsInspected ?? 0,
    pagesProcessedTotal: stored?.pagesProcessed ?? 0,
    pageFailuresTotal: stored?.pageFailures ?? 0,
    pageFailed: false,
  };
}

/**
 * Who could hold this work (R2B, owner Decision 2). **RECOMMENDATION ONLY.**
 *
 * The cycle never assigns anyone, grants authority, alters workload, notifies a consultant,
 * sends a message, approves anything or performs the work. That is structural, not a
 * convention: this function returns snapshot ROWS, and the create RPC it feeds accepts no
 * accountable owner at all, so there is no shape in which a cycle can make an assignment.
 *
 * EVERY failure mode below produces a TRUTHFUL `needs_routing` snapshot with an exact reason
 * rather than a candidate. The owner's rule — "never select an unchecked candidate to keep the
 * cycle moving" — is enforced by there being no branch that returns one.
 */
interface PeopleCache {
  candidates?: { ok: true; value: readonly CandidateEvidence[] } | { ok: false; error: string };
  signals?: SignalLookup | null;
}

async function resolveForItem(
  deps: CycleDeps,
  o: Observation,
  rec: PersistRecommendation,
  action: { capability: string | null; department: Department } | null,
  cache: PeopleCache,
): Promise<RecommendationSnapshot[]> {
  // No loader configured: no recommendation is made, and the surface says exactly that.
  // This is NOT "nobody is suitable" — a claim we have no evidence for.
  if (!deps.loadCandidates) return [];

  const routed = (reasonCode: string, detail: string): RecommendationSnapshot[] => [{
    purpose: "assignee", outcome: "needs_routing",
    candidate_ref: null, candidate_type: null, rank_position: null,
    capabilities_used: [], skills_used: [], availability: null, confidence: null,
    reason_codes: [reasonCode], reasons: [{ code: reasonCode, detail }], missing_codes: [],
    routing_department: o.department, routing_reason_code: reasonCode,
    evidence_refs: [],
  }];

  // An unregistered action means we do not know what capability the work needs. Resolving
  // without that would offer someone for work whose requirements were never established.
  if (!action) return routed("action_not_registered", `proposed action ${rec.actionId} is not in the catalogue`);

  // WHICH ROLES this work needs — from the catalogue entry and the observation's structured
  // facts, never from a model (R2C).
  const required = requiredRolesFor(action as ActionWithRoles, o);
  const spec = roleSpecOf(action as ActionWithRoles);

  // LOADED ONCE PER CYCLE, not once per observation. A twelve-domain sweep can produce dozens
  // of observations, and re-reading every membership, role, capability, leave row, capacity
  // snapshot and the entire outcome history for each of them turned one recommendation into
  // dozens of full table scans. The cache also makes the cycle self-consistent: every item in
  // one sweep is judged against the SAME picture of the company, rather than against whatever
  // the database happened to look like a few milliseconds apart.
  if (!cache.candidates) {
    try {
      cache.candidates = { ok: true, value: await deps.loadCandidates(o.companyId) };
    } catch (e) {
      cache.candidates = { ok: false, error: (e as Error).message };
    }
  }
  if (!cache.candidates.ok) {
    return routed("candidate_evidence_unavailable", `candidate evidence could not be read: ${cache.candidates.error}`);
  }
  const candidates = cache.candidates.value;

  if (cache.signals === undefined) {
    try {
      cache.signals = (await deps.loadSignals?.(o.companyId)) ?? null;
    } catch {
      // Learning is an ORDERING input. Losing it is not a reason to refuse to recommend, and it
      // is not a reason to pretend history exists — the resolver simply proceeds without it.
      cache.signals = null;
    }
  }
  const signalFor = cache.signals ?? undefined;

  // ONE RESOLUTION PER ROLE, and one snapshot set per role. Roles are resolved separately
  // rather than in a single call because they have different requirements, different history
  // and different failure consequences — and because a shared call would make it possible to
  // return an advisor where an assignee was asked for. The owner's rule that one role is never
  // silently substituted for another is enforced by them never sharing a result.
  const out: RecommendationSnapshot[] = [];
  for (const need of required) {
    const roleSnapshots = await resolveOneRole(deps, o, rec, action, spec, need, candidates, signalFor);
    // A MANDATORY role that found nobody means the work cannot proceed as proposed. An OPTIONAL
    // one records its own truthful needs_routing and leaves everything else standing — a missing
    // advisor must not invalidate a valid assignee (owner Decision, R2C).
    out.push(...roleSnapshots);
  }
  return out;
}

/** Resolve exactly one role, and turn it into snapshots that name that role. */
async function resolveOneRole(
  deps: CycleDeps,
  o: Observation,
  rec: PersistRecommendation,
  action: { capability: string | null; department: Department },
  spec: ReturnType<typeof roleSpecOf>,
  need: RoleRequirement,
  candidates: readonly CandidateEvidence[],
  signalFor: SignalLookup | undefined,
): Promise<RecommendationSnapshot[]> {
  const routedForRole = (reasonCode: string, detail: string): RecommendationSnapshot[] => [{
    purpose: need.role, outcome: "needs_routing",
    candidate_ref: null, candidate_type: null, rank_position: null,
    capabilities_used: [], skills_used: [], availability: null, confidence: null,
    reason_codes: [reasonCode], reasons: [{ code: reasonCode, detail }], missing_codes: [],
    routing_department: o.department, routing_reason_code: reasonCode,
    evidence_refs: [],
  }];

  try {
    const resolution = resolveCandidates(
      {
        companyId: o.companyId,
        department: o.department,
        // Keyed on the ACTION, so outcome history is specific to this kind of work.
        taskKind: rec.actionId,
        roles: [need.role],
        requiredCapability: need.role === "assignee" ? action.capability : null,
        requiredVerifiedSkills: spec.requiredVerifiedSkills,
        preferredSkills: spec.preferredSkills,
        requiredLanguage: spec.requiredLanguage ?? null,
        authorityDomain: spec.domain ?? null,
        allowExternalConsultants: need.role === "external_consultant",
        // `automatic`, deliberately, and NOT rec.requiredAuthority.
        //
        // The item's required authority is the level needed to APPROVE the proposed action. The
        // assignee is the person who would DO the work once a human has approved it. Conflating
        // the two would mean only people senior enough to approve something could ever be
        // recommended to do it — a manager approving and then performing every task — and would
        // route ordinary work to `needs_routing` for want of an approval right the doer does not
        // need. Approval authority is checked separately, against the approver, at approval time.
        requiredAuthority: "automatic",
        authorityAmount: null,
        onDateIso: deps.now().toISOString().slice(0, 10),
        estimateHours: null,
        now: deps.now(),
      },
      candidates,
      signalFor ? { signalFor } : {},
    );

    // A TEAM is not "the top N candidates" (defect R2C-F-001: formTeam existed, was tested, and
    // nothing on the runtime path called it — the same shape as WRK-007 being held back). When
    // the action asks for a team, the eligible pool goes through complementary selection and the
    // snapshots carry the coverage, the gaps and the ONE accountable lead.
    if ((need.minimum ?? 1) > 1 && resolution.outcome === "candidates") {
      const team = formTeam(resolution.candidates, {
        minimum: need.minimum!,
        mustCover: spec.teamMustCover.length > 0
          ? spec.teamMustCover
          : (action.capability ? [action.capability] : []),
        leadCapability: action.capability,
      });

      const teamReasons = team.reasons.map((r) => r.code);
      return team.members.map((m, i) => {
        const base = buildSnapshots({ ...resolution, candidates: [m] })[0]!;
        const isLead = team.lead?.membershipId === m.membershipId;
        return {
          ...base,
          purpose: need.role,
          // Position 1 is the accountable LEAD. It is an order, not a score.
          rank_position: i + 1,
          reason_codes: [
            ...base.reason_codes,
            isLead ? "team_lead" : "team_member",
            ...teamReasons,
          ],
          reasons: [
            ...base.reasons,
            {
              code: isLead ? "team_lead" : "team_member",
              detail: isLead
                ? "proposed as the accountable lead for this team"
                : "proposed as a team member; not accountable for delivery",
            },
            ...team.reasons,
          ],
          // What the team CANNOT cover travels with every member, so the gap is visible
          // wherever the proposal is read rather than only on one row.
          missing_codes: [
            ...base.missing_codes,
            ...team.missingCapabilities.map((c) => `team_missing:${c}`),
            ...(team.understaffed ? ["team_understaffed"] : []),
            ...(team.lead ? [] : ["team_without_lead"]),
          ],
        };
      });
    }

    const snaps = buildSnapshots(resolution);
    // buildSnapshots labels everything "assignee" because it cannot know which role was asked
    // for. Stamping the role HERE, from the requirement, is what makes a substitution
    // impossible: a snapshot can only ever carry the role its own resolution was run for.
    return snaps.map((s) => ({ ...s, purpose: need.role }));
  } catch (e) {
    // A resolver that throws must never be reported as "nobody qualified".
    return routedForRole("resolver_failed", `candidate resolution failed: ${(e as Error).message}`);
  }
}

/** The global switch. Server-side only — never `NEXT_PUBLIC_`. */
export function kernelGloballyEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MANAGEMENT_KERNEL === "on";
}

/** The registered sources, and how each turns loaded rows into observations. */
const SOURCES: ReadonlyArray<{
  source: string;
  department: Department;
  detect(rows: unknown, ctx: { companyId: string; correlationId: string; now: Date }): Observation[];
}> = [
  {
    source: FINANCE_SOURCE, department: "finance",
    detect: (rows, ctx) => detectFinanceObservations({ ...ctx, invoices: rows as never }),
  },
  {
    source: WORKFORCE_SOURCE, department: "workforce",
    detect: (rows, ctx) => detectWorkforceObservations({ ...ctx, capacities: rows as never }),
  },
  {
    source: OPERATIONS_SOURCE, department: "operations",
    detect: (rows, ctx) => detectOperationsObservations({ ...ctx, tasks: rows as never }),
  },
  {
    source: CRM_SOURCE, department: "crm",
    detect: (rows, ctx) => detectCrmObservations({ ...ctx, conversations: rows as never }),
  },
  {
    source: SYSTEM_SOURCE, department: "system",
    // The system-health adapter takes a shaped signal object rather than a row list.
    detect: (rows, ctx) => detectSystemHealthObservations({ ...ctx, ...(rows as object) } as never),
  },

  // ── R2A: the remaining seven managed domains ───────────────────────────────────────
  {
    source: GOVERNANCE_SOURCE, department: "governance",
    detect: (rows, ctx) => detectGovernanceObservations({ ...ctx, directives: rows as never }),
  },
  {
    source: OBJECTIVES_SOURCE, department: "objectives",
    detect: (rows, ctx) => detectObjectiveObservations({ ...ctx, objectives: rows as never }),
  },
  {
    source: MARKETING_SOURCE, department: "marketing",
    detect: (rows, ctx) => detectMarketingObservations({ ...ctx, campaigns: rows as never }),
  },
  {
    source: PROCUREMENT_SOURCE, department: "procurement",
    detect: (rows, ctx) => detectProcurementObservations({ ...ctx, inventory: rows as never }),
  },
  {
    source: ASSETS_SOURCE, department: "assets",
    detect: (rows, ctx) => detectAssetObservations({ ...ctx, documents: rows as never }),
  },
  {
    source: LEGAL_SOURCE, department: "legal",
    detect: (rows, ctx) => detectLegalObservations({ ...ctx, records: rows as never }),
  },
  {
    source: PROVIDERS_SOURCE, department: "providers",
    detect: (rows, ctx) => detectProviderObservations({ ...ctx, providers: rows as never }),
  },
];

export const REGISTERED_SOURCE_COUNT = SOURCES.length;

/**
 * Run one management cycle for one company.
 *
 * NEVER THROWS. Every outcome is a typed summary. A cycle that RAN (including one that was
 * locked out or failed) is recorded, because a sweep that vanishes without trace is worse
 * than one reporting failure. A DISABLED cycle writes nothing — it did not run.
 */
export async function runManagementCycle(deps: CycleDeps, req: CycleRequest): Promise<CycleSummary> {
  const startedAt = deps.now().getTime();
  const correlationId = req.correlationId ?? randomUUID();

  const base: CycleSummary = {
    correlationId,
    companyId: req.companyId,
    trigger: req.trigger,
    status: "completed",
    sourcesRegistered: SOURCES.length,
    verification: emptySweepSummary(),
    sourcesSucceeded: 0,
    sourcesFailed: 0,
    itemsCreated: 0,
    itemsReused: 0,
    observationsSkipped: 0,
    observationsRejected: 0,
    recommendationsRecorded: 0,
    itemsNeedingRouting: 0,
    truncatedSources: [],
    cursorCommitFailed: [],
    recordsInspected: 0,
    pagesProcessed: 0,
    continuation: [],
    reconciliation: [],
    reconcileReserve: 0,
    rescanReserve: 0,
    cursorReset: [],
    reconciliationDelayed: [],
    cursorResetReasons: [],
    budgetExhausted: false,
    resolutionPermitted: false,
    unobservedDepartments: [],
    failureReason: null,
    durationMs: 0,
  };

  /**
   * DISABLED IS ZERO-WRITE.
   *
   * A disabled cycle returns a typed result in memory and touches NOTHING: no run record,
   * no audit event, no lock, no detector, no company operational data. Recording a run row
   * while disabled would be a database write performed by a cycle that never ran, and it
   * would let a reader believe the business was observed.
   *
   * The distinction between "nobody needed attention" and "the kernel is disabled" survives
   * in the returned STATUS and in non-sensitive server logging - never in a company table.
   */
  const disabled = (reason: string): CycleSummary => {
    const out: CycleSummary = {
      ...base, status: "skipped_disabled", failureReason: reason,
      sourcesRegistered: 0, durationMs: deps.now().getTime() - startedAt,
    };
    // Server-side log only: status, trigger and correlation. No record data, no evidence,
    // no company name, no secret.
    log("info", "management cycle skipped - kernel disabled", {
      event: "management_cycle.skipped_disabled",
      correlationId: out.correlationId,
      trigger: out.trigger,
      reason,
    });
    return out;
  };

  const finish = async (s: CycleSummary): Promise<CycleSummary> => {
    const out = { ...s, durationMs: deps.now().getTime() - startedAt };
    try {
      await deps.recordRun(out, req.actorId);
    } catch {
      // A failure to record the run must not mask the cycle's own outcome; the caller
      // still receives a truthful summary.
    }
    return out;
  };

  // ── 1. BOTH switches, before anything is read ────────────────────────────────────────
  // The GLOBAL switch is checked first, so a globally-disabled kernel reads nothing at all -
  // not even the per-company enablement row.
  if (!kernelGloballyEnabled()) {
    return disabled("global flag MANAGEMENT_KERNEL is not on");
  }
  let companyEnabled = false;
  try {
    companyEnabled = await deps.isCompanyEnabled(req.companyId);
  } catch (e) {
    return finish({ ...base, status: "failed", failureReason: `enablement check failed: ${(e as Error).message}`, sourcesRegistered: 0 });
  }
  if (!companyEnabled) {
    return disabled("company enablement is absent or false");
  }

  // ── 2. Company-scoped concurrency lock ───────────────────────────────────────────────
  let locked = false;
  try {
    locked = await deps.tryLock(req.companyId);
  } catch (e) {
    return finish({ ...base, status: "failed", failureReason: `lock failed: ${(e as Error).message}` });
  }
  if (!locked) {
    return finish({ ...base, status: "skipped_locked", failureReason: "another cycle is already running for this company" });
  }

  const summary = { ...base, verification: emptySweepSummary() };

  try {
    const authority = await deps.authorityFor(req.companyId);
    const ctx = { companyId: req.companyId, correlationId, now: deps.now() };

    // ── 3-11. Each registered source, bounded and independent ─────────────────────────
    // Loaded once per cycle, so every item in one sweep is judged against the SAME picture
    // of the company (see resolveForItem).
    const peopleCache: PeopleCache = {};

    // R2S-P is active only when the deployment supplies a paged reader; otherwise the cycle
    // behaves exactly as before, so every existing caller and test is untouched.
    const paged = typeof deps.loadPage === "function";

    // R2S-P. Sources are visited in a ROTATING order seeded by the sweep generation, so when
    // the whole-cycle row budget runs out the same sources are not starved every time. The
    // rotation is deterministic, so a cycle remains reproducible.
    // R2S-P handoff. Reconciliation gets its OWN budget, not the incremental sweep's
    // leftovers.
    //
    // Sharing one budget made reconciliation depend on incremental traffic being light. A
    // company writing steadily — which is what a busy company DOES — could spend the whole
    // budget on new rows every cycle, and the full sweep that guarantees eventual discovery
    // would never run. "It works when the system is quiet" is not a guarantee.
    //
    // So the reserve is carved out of the same total (the cycle stays bounded by
    // CYCLE_ROW_BUDGET) and is large enough for EVERY keyset source to take a full page every
    // cycle. No rotation, no leftovers, no dependence on load: each source's reconciliation
    // advances by RECONCILE_PAGE rows per cycle, so a table of N rows is swept in
    // ceil(N / RECONCILE_PAGE) cycles whatever else is happening.
    const reconcilingSources = paged
      ? SOURCES.filter((x) => needsReconcileSweep(x.source)).length
      : 0;
    const reserve = (RECONCILE_PAGE + RESCAN_PAGE) * reconcilingSources;
    const budget = new RowBudget(Math.max(PAGE_SIZE, CYCLE_ROW_BUDGET - reserve));
    // Two purposes, two budgets. Forward coverage and backdated recovery each get a
    // guaranteed slice, so neither can be squeezed out by the other or by incremental load.
    const reconcileBudget = new RowBudget(RECONCILE_PAGE * reconcilingSources);
    const rescanBudget = new RowBudget(RESCAN_PAGE * reconcilingSources);
    // Reported apart, because they are two separate guarantees: forward coverage cannot be
    // squeezed out by recovery, nor recovery by coverage.
    summary.reconcileReserve = RECONCILE_PAGE * reconcilingSources;
    summary.rescanReserve = RESCAN_PAGE * reconcilingSources;
    const generationSeed = paged ? await seedGeneration(deps, req.companyId) : 0;
    let allSweepsComplete = paged;

    for (const s of rotate(SOURCES, generationSeed)) {
      let observations: Observation[];
      let pageState: PageOutcome | null = null;
      let existingByIdentity: Map<string, ExistingItem> | null = null;

      try {
        let rows: unknown;
        if (paged) {
          pageState = await readOnePage(deps, s.source, req.companyId, budget, reconcileBudget, rescanBudget);
          rows = pageState.rows;
          summary.recordsInspected += pageState.inspected;
          summary.pagesProcessed += pageState.pages;
          if (!pageState.complete) allSweepsComplete = false;
        } else {
          rows = await deps.loadFor(s.source, req.companyId);
        }
        const produced = s.detect(rows, ctx);
        // 5. VALIDATE the adapter result. A detector that returns a non-array is a
        //    failure, not an empty result.
        if (!Array.isArray(produced)) throw new Error("adapter did not return an array");
        observations = produced;

        // 5b. One bounded identity lookup for the whole page, rather than one per
        //     observation — and inside THIS try, so an unreadable lookup fails its own
        //     source exactly as an unreadable table does, instead of aborting the cycle.
        //
        //     A failure here is emphatically NOT "nothing exists": that reading would create
        //     a second item for every condition already open.
        const identityKeys = [...new Set(observations.map((o) => o.identityKey))];
        existingByIdentity = deps.findExistingByIdentities
          ? await deps.findExistingByIdentities({ companyId: req.companyId, identityKeys })
          : null;
      } catch (e) {
        // A failing adapter marks ITS department unobserved and the cycle partial. It never
        // becomes a silent success, and it never aborts the other sources.
        summary.sourcesFailed++;
        summary.unobservedDepartments.push(s.department);
        allSweepsComplete = false;
        continue;
      }
      summary.sourcesSucceeded++;
      // A page whose items did not all persist must NOT advance the cursor: the unpersisted rows
      // would never be read again.
      let failedThisSource = false;

      for (const o of observations) {
        // 6. DEDUPLICATE, and fail closed on anything unsafe.
        const existing = existingByIdentity
          ? existingByIdentity.get(o.identityKey) ?? null
          : await deps.findByIdentity(req.companyId, o.identityKey);
        const decision: IngestDecision = ingestObservation(o, { companyId: req.companyId }, existing);

        if (decision.action === "reject") {
          summary.observationsRejected++;
          continue;
        }
        if (decision.action === "skip") {
          summary.observationsSkipped++;
          continue;
        }
        if (decision.action === "reuse") {
          summary.itemsReused++;
          continue;
        }

        // 8-9. Prioritisation rides on the observation; the recommendation may only ever be
        //      a catalogue-registered, internal-only action.
        const interpretation = await interpretWithGuards(o, o.evidence, fixtureInterpreter());
        let rec: PersistRecommendation | null = null;
        try {
          const built = buildRecommendation({ observation: o, interpretation, authority });
          if (built) {
            rec = {
              actionId: built.action.id,
              requiredAuthority: built.requiredAuthority, // 10. authority from the existing engine
              evidenceQuality: built.evidenceQuality,
              mayRunUnattended: built.mayRunUnattended,
            };
          }
        } catch {
          // A recommendation that cannot be made is not a reason to lose the observation:
          // the item is still recorded, with no proposed action, for a human to look at.
          rec = null;
        }

        // 11. WHO could hold this work (R2B, owner Decision 2). RECOMMENDATION ONLY: the
        //     resolver returns candidates, nothing is assigned, no authority is granted, no
        //     workload changes and nobody is notified. The accountable owner stays NULL until
        //     an authorised human accepts, which the create RPC guarantees by not accepting it.
        const snapshots = rec
          ? await resolveForItem(deps, o, rec, actionById(rec.actionId) ?? null, peopleCache)
          : [];

        // 7 + 12. Persist item, evidence, the opening transition and the recommendation
        //         snapshots in ONE transaction, carrying the correlation id.
        try {
          await deps.persist(o, rec, snapshots);
          summary.itemsCreated++;
          if (snapshots.length > 0) summary.recommendationsRecorded += snapshots.length;
          if (snapshots.some((s) => s.outcome === "needs_routing")) summary.itemsNeedingRouting++;
        } catch {
          // A persistence failure for one observation must not lose the other departments'
          // work, and must not be reported as success.
          failedThisSource = true;
          summary.observationsRejected++;
          if (!summary.unobservedDepartments.includes(s.department)) {
            summary.unobservedDepartments.push(s.department);
          }
        }
      }

      // ── ATOMICITY. The cursor advances ONLY here: after every observation on this page has
      //    been ingested and persisted. A failure above leaves the cursor exactly where it was
      //    and the page is retried — idempotently, because item creation is keyed on the
      //    identity key and returns the original item for a repeat.
      if (paged && pageState) {
        const pageFailed = pageState.pageFailed || failedThisSource;
        try {
          await deps.writeCursor?.({ companyId: req.companyId, source: s.source }, {
            // A failed page does not move the position.
            cursor: pageFailed ? pageState.previousCursor : pageState.next,
            generation: pageState.complete && !pageFailed
              ? pageState.generation + 1
              : pageState.generation,
            // A completion time is recorded ONLY for a generation that finished with no page
            // failure. Any future resolve-on-absence logic gates on exactly this.
            sweepCompleteAt: pageState.complete && !pageFailed
              ? deps.now().toISOString()
              : pageState.sweepCompleteAt,
            rowsInspected: pageState.rowsInspectedTotal + pageState.inspected,
            pagesProcessed: pageState.pagesProcessedTotal + pageState.pages,
            pageFailures: pageState.pageFailuresTotal + (pageFailed ? 1 : 0),
            status: pageFailed ? "failed" : pageState.complete ? "complete" : "in_progress",
          });
        } catch {
          // Losing the cursor write is not a reason to fail the cycle: the page's items are
          // already persisted, and the next sweep re-reads from the old position. Re-reading is
          // absorbed by identity-key deduplication; the alternative is skipping rows.
          //
          // It IS a reason not to claim a clean sweep. This was previously pushed onto
          // `truncatedSources`, which step 13 then overwrote wholesale — so a lost position was
          // recorded nowhere and changed nothing (R2S-P-F-003).
          summary.cursorCommitFailed.push(s.source);
        }
        // The reconciliation position is committed the same way and under the same rule: only
        // after this cycle's items are persisted, and never on a failed page.
        if (pageState.rescan) {
          const rs = pageState.rescan;
          try {
            await deps.writeCursor?.(
              { companyId: req.companyId, source: rescanSourceKey(s.source) },
              {
                cursor: pageFailed ? null : rs.next,
                generation: rs.complete && !pageFailed ? rs.generation + 1 : rs.generation,
                // A recovery pass never claims coverage, so it never stamps completion.
                sweepCompleteAt: null,
                rowsInspected: rs.inspected,
                pagesProcessed: rs.inspected > 0 ? 1 : 0,
                pageFailures: 0,
                status: pageFailed ? "failed" : "in_progress",
              },
            );
          } catch {
            summary.cursorCommitFailed.push(rescanSourceKey(s.source));
          }
        }

        if (pageState.reconcile) {
          const r = pageState.reconcile;
          try {
            await deps.writeCursor?.(
              { companyId: req.companyId, source: reconcileSourceKey(s.source) },
              {
                cursor: pageFailed ? r.previous : r.next,
                // A generation whose position was reset mid-flight did NOT sweep the whole
                // table: it restarted somewhere unknown. It may not count as a completed
                // generation, and it may not stamp a completion time, because that stamp is
                // what any future resolve-on-absence logic gates on.
                generation:
                  (r.complete && !pageFailed && !r.wasReset) || r.delayed
                    ? r.generation + 1
                    : r.generation,
                // A generation that was ABANDONED or RESET did not sweep the table. It
                // stamps no completion time — and clears any older one, so nothing can
                // later read a stale stamp as though this pass had finished.
                sweepCompleteAt:
                  r.complete && !pageFailed && !r.wasReset && !r.dirty
                    ? deps.now().toISOString()
                    : r.delayed || r.wasReset || (r.complete && r.dirty)
                      ? null
                      : r.sweepCompleteAt,
                // Counters are PER GENERATION: they reset whenever one ends, however it
                // ended, because the work bound is a statement about one pass.
                rowsInspected:
                  (r.complete && !pageFailed) || r.delayed ? 0 : r.rowsInspectedTotal + r.inspected,
                pagesProcessed:
                  (r.complete && !pageFailed) || r.delayed
                    ? 0
                    : r.pagesProcessedTotal + (r.inspected > 0 ? 1 : 0),
              pageFailures: 0,
                // "blocked" is how a dirty pass remembers it was interrupted, so the wrap
                // that eventually follows cannot quietly claim to have seen everything.
                status: pageFailed
                  ? "failed"
                  : r.delayed || r.wasReset
                    ? "blocked"
                    : r.complete
                      ? "complete"
                      : r.dirty
                        ? "blocked"
                        : "in_progress",
              },
            );
          } catch {
            summary.cursorCommitFailed.push(reconcileSourceKey(s.source));
          }
          summary.reconciliation.push({
            source: s.source,
            generation: r.generation,
            hasMore: !r.complete,
            inspected: r.inspected,
          });
          // A source whose FULL sweep is still running has not finished reconciling, whatever
          // the incremental cursor says. Resolve-on-absence must never be licensed by an
          // incremental page that merely ran out of new timestamps.
          if (r.delayed) {
            summary.reconciliationDelayed.push(s.source);
          }
          if (!r.complete || r.dirty) allSweepsComplete = false;
        }

        if (pageState.cursorWasReset) {
          summary.cursorReset.push(s.source);
          summary.cursorResetReasons.push(
            `${s.source}: ${pageState.cursorProblem ?? "unusable"}`,
          );
          // Nothing observed through a restarted position may license resolution this cycle.
          allSweepsComplete = false;
        }
        if (pageFailed) allSweepsComplete = false;
        summary.continuation.push({
          source: s.source,
          generation: pageState.generation,
          hasMore: !pageState.complete,
        });
      }
    }

    summary.budgetExhausted = budget.exhausted;
    // A generation whose completion could not be RECORDED has not verifiably finished, so it
    // cannot license resolve-on-absence either.
    summary.resolutionPermitted =
      paged && allSweepsComplete && summary.sourcesFailed === 0 &&
      summary.cursorCommitFailed.length === 0;

    // 13. A cycle that did not observe everything it registered is PARTIAL, never complete.
    //     A TRUNCATED read counts: looking at the first 500 rows of a domain and reporting
    //     "completed" claims a sweep that did not happen.
    summary.truncatedSources = [...(deps.truncatedSources?.() ?? [])];

    // ── Scheduled outcome verification ────────────────────────────────────────────────────
    //
    // Runs only AFTER the source results are established, and only when this cycle actually
    // finished looking: a partial cycle cannot support a conclusion about whether a business
    // condition was resolved, least of all a negative one, where "the detector did not raise it"
    // is exactly what a half-finished sweep looks like.
    //
    // Bounded per company per cycle, so a queue of pending verifications cannot starve the twelve
    // domain reads. Deterministic and provider-free — no model is asked whether work succeeded.
    if (deps.verificationSweep) {
      const cycleComplete =
        summary.sourcesFailed === 0 &&
        summary.unobservedDepartments.length === 0 &&
        summary.truncatedSources.length === 0 &&
        summary.cursorCommitFailed.length === 0 &&
        !summary.budgetExhausted;
      try {
        summary.verification = await deps.verificationSweep({
          companyId: req.companyId,
          cycleComplete,
        });
      } catch (e) {
        // The sweep itself failed. That is not a conclusion about any item, and the cycle says so
        // rather than reporting calm completion.
        summary.verification = { ...emptySweepSummary(), failed: 1, partial: true };
        log("error", "verification sweep failed", {
          event: "cycle.verification_failed",
          companyId: req.companyId,
          error: (e as Error).message,
        });
      }
    }

    const hasMore =
      summary.continuation.some((c) => c.hasMore) ||
      summary.reconciliation.some((r) => r.hasMore) ||
      summary.cursorReset.length > 0 ||
      summary.reconciliationDelayed.length > 0;
    summary.status =
      summary.sourcesFailed > 0 ||
      summary.unobservedDepartments.length > 0 ||
      summary.truncatedSources.length > 0 ||
      summary.cursorCommitFailed.length > 0 ||
      hasMore ||
      summary.budgetExhausted ||
      // Verification work left unknown is work left undone.
      summary.verification.partial
        ? "partial"
        : "completed";
    if (summary.status === "partial") {
      const parts: string[] = [];
      if (summary.unobservedDepartments.length > 0) {
        parts.push(`unobserved: ${summary.unobservedDepartments.join(", ")}`);
      }
      if (summary.truncatedSources.length > 0) {
        parts.push(`truncated (row cap reached): ${summary.truncatedSources.join(", ")}`);
      }
      const more = summary.continuation.filter((c) => c.hasMore).map((c) => c.source);
      if (more.length > 0) {
        parts.push(`more to read (continuation pending): ${more.join(", ")}`);
      }
      const reconciling = summary.reconciliation.filter((r) => r.hasMore).map((r) => r.source);
      if (reconciling.length > 0) {
        parts.push(`reconciliation sweep in progress: ${reconciling.join(", ")}`);
      }
      if (summary.budgetExhausted) {
        parts.push("cycle row budget exhausted; remaining sources continue next cycle");
      }
      if (summary.verification.partial) {
        parts.push(
          `verification incomplete: ${summary.verification.remaining} item(s) still pending`,
        );
      }
      if (summary.reconciliationDelayed.length > 0) {
        parts.push(
          "reconciliation delayed (generation abandoned unfinished; it restarts from the " +
            "beginning): " + summary.reconciliationDelayed.join(", "),
        );
      }
      if (summary.cursorReset.length > 0) {
        parts.push(
          "stored position unusable; sweep restarted: " + summary.cursorReset.join(", "),
        );
      }
      if (summary.cursorCommitFailed.length > 0) {
        parts.push(
          "position not committed (items are safe; the page will be re-read): " +
            summary.cursorCommitFailed.join(", "),
        );
      }
      summary.failureReason = parts.join("; ") || "incomplete sweep";
    }
    return await finish(summary);
  } catch (e) {
    return await finish({ ...summary, status: "failed", failureReason: (e as Error).message });
  } finally {
    // 14. Release the lock whatever happened.
    try {
      await deps.releaseLock(req.companyId);
    } catch {
      /* the advisory lock is released with the session in any case */
    }
  }
}
