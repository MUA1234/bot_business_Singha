/**
 * The verification runtime path.
 *
 * Loads the item and its originating record from the database, asks the boundary, and applies the
 * lifecycle transition through the existing `r1_draft_transition_item()` — which re-locks the item
 * and re-checks the from-state, so two concurrent verifications cannot produce conflicting terminal
 * outcomes.
 *
 * The re-read is TARGETED: the exact originating record, by the identity the item recorded. Nothing
 * here infers resolution from absence, and nothing consults `updated_at`.
 */
import type { SqlExec } from "../execution/ledger";
import type { Department } from "../types";
import {
  type ItemUnderVerification,
  type SourceRead,
  type SweepState,
  type VerificationResult,
  result,
} from "./contract";
import type { TaskUnderVerification } from "./rules";
import { verifyOutcome } from "./verify";

export interface VerificationEnvironment {
  readonly sql: SqlExec;
  /** Injected so a test can drive time deterministically. */
  now(): Date;
}

/** The evidence digest, computed by the same SQL function the decision boundary uses. */
async function evidenceGeneration(sql: SqlExec, company: string, item: string): Promise<string> {
  const { rows } = await sql(`select public.r1_draft_evidence_digest($1,$2) as d`, [company, item]);
  return String(rows[0]?.d ?? "empty");
}

/**
 * Load the item, as the verifier needs it.
 *
 * `claimedAt` is the transition INTO the verifying state — the moment completion was claimed. It
 * is read from the append-only transition log rather than from any column that a later edit could
 * move.
 */
async function loadItem(
  sql: SqlExec,
  company: string,
  itemId: string,
): Promise<ItemUnderVerification | null> {
  const { rows } = await sql(
    `select i.id, i.company_id, i.department, i.kind, i.subject_table, i.subject_id, i.state,
            (select max(t.created_at) from management_item_transitions t
              where t.item_id = i.id and t.to_state in ('verifying','monitoring')) as claimed_at
       from management_items i
      where i.company_id = $1 and i.id = $2`,
    [company, itemId],
  );
  const row = rows[0];
  if (!row || row.claimed_at == null) return null;

  return {
    id: String(row.id),
    companyId: String(row.company_id),
    department: String(row.department) as Department,
    kind: String(row.kind),
    subjectTable: String(row.subject_table),
    subjectId: String(row.subject_id),
    state: String(row.state),
    evidenceGeneration: await evidenceGeneration(sql, company, itemId),
    claimedAt: new Date(String(row.claimed_at)),
  };
}

/**
 * Re-read the originating task.
 *
 * A thrown error becomes `{ ok: false }` — "we could not look" — and a missing row becomes
 * `{ ok: true, row: null }` — "it is not there". The rule treats those differently and must be
 * able to, so they are never collapsed here.
 *
 * `requires_evidence` and the VERIFIED evidence count come from the record itself, because a task
 * closed on somebody's word alone is a claim, not a verification.
 */
async function readTask(
  sql: SqlExec,
  company: string,
  taskId: string,
): Promise<SourceRead<TaskUnderVerification>> {
  try {
    const { rows } = await sql(
      `select t.id, t.title, t.status, t.due_date, t.requires_evidence,
              (select max(c.created_at) from task_check_ins c where c.task_id = t.id) as last_check_in_at,
              (select count(*)::int from task_evidence e
                where e.task_id = t.id and e.verified_by is not null) as verified_evidence_count
         from tasks t
        where t.company_id = $1 and t.id = $2`,
      [company, taskId],
    );
    const row = rows[0];
    if (!row) return { ok: true, row: null };

    return {
      ok: true,
      row: {
        id: String(row.id),
        title: String(row.title ?? ""),
        status: String(row.status) as TaskUnderVerification["status"],
        dueDate: row.due_date == null ? null : String(row.due_date),
        lastCheckInAt: row.last_check_in_at == null ? null : String(row.last_check_in_at),
        estimateHours: null,
        requiresEvidence: row.requires_evidence === true,
        verifiedEvidenceCount: Number(row.verified_evidence_count ?? 0),
      },
    };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export interface VerificationRunResult extends VerificationResult {
  /** True only when the lifecycle actually moved. */
  readonly transitioned: boolean;
}

/**
 * Verify one item and, when the conclusion warrants it, move the lifecycle.
 *
 * The transition goes through `r1_draft_transition_item()`, which takes the item FOR UPDATE and
 * re-checks the from-state. Two concurrent verifications therefore serialise: the second sees the
 * first's committed state and its transition is refused, so the item cannot end in two terminal
 * outcomes at once.
 */
export async function verifyManagementOutcome(
  env: VerificationEnvironment,
  input: { companyId: string; itemId: string; actorId: string | null; sweep: SweepState },
): Promise<VerificationRunResult> {
  const { sql } = env;

  const item = await loadItem(sql, input.companyId, input.itemId);
  if (!item) {
    return {
      ...result("unavailable", "the item is not available, or no completion has been claimed"),
      transitioned: false,
    };
  }

  const read =
    item.subjectTable === "tasks"
      ? await readTask(sql, input.companyId, item.subjectId)
      : ({ ok: false, reason: `no reader for ${item.subjectTable}` } as SourceRead<TaskUnderVerification>);

  const verdict = verifyOutcome({
    item,
    companyId: input.companyId,
    // Re-derived from the item's OWN row, not from anything a caller said.
    observed: { subjectTable: item.subjectTable, subjectId: item.subjectId },
    evidenceGenerationNow: await evidenceGeneration(sql, input.companyId, input.itemId),
    sweep: input.sweep,
    read,
    now: env.now(),
  });

  if (!verdict.transitionTo) return { ...verdict, transitioned: false };

  const { rows } = await sql(
    `select public.r1_draft_transition_item($1,$2,$3,$4,'user',$5,'[]'::jsonb) as r`,
    [item.id, item.state, verdict.transitionTo, input.actorId, verdict.detail],
  );
  const moved = (rows[0]?.r as { ok?: boolean } | undefined)?.ok === true;

  return { ...verdict, transitioned: moved };
}
