/**
 * The direct-PostgreSQL transport for verification.
 *
 * Used by a worker holding a real connection, and by the live tests. It is transport ONLY: the SQL
 * below fetches and writes rows, and every decision — which items are due, what the outcome is,
 * which lifecycle transition follows, how long the backoff is — belongs to the single
 * implementation in `schedule.ts`, `service.ts`, `verify.ts` and `rules.ts`.
 */
import type { SqlExec } from "../execution/ledger";
import type { SourceRead } from "./contract";
import type { TaskUnderVerification } from "./rules";
import type {
  AttemptRecord,
  ItemRow,
  PendingVerification,
  TransitionRequest,
  VerificationStore,
} from "./store";

export function createSqlVerificationStore(sql: SqlExec): VerificationStore {
  return {
    transport: "postgres",

    async listPending(companyId) {
      const { rows } = await sql(
        `select i.id,
                coalesce(s.attempts, 0) as attempts,
                s.next_attempt_at
           from management_items i
           left join management_verification_schedule s
                  on s.company_id = i.company_id and s.item_id = i.id
          where i.company_id = $1
            and i.state in ('verifying', 'monitoring')`,
        [companyId],
      );
      return rows.map<PendingVerification>((r) => ({
        itemId: String(r.id),
        attempts: Number(r.attempts ?? 0),
        nextAttemptAt: r.next_attempt_at == null ? null : new Date(String(r.next_attempt_at)),
      }));
    },

    async loadItem(companyId, itemId) {
      const { rows } = await sql(
        `select i.id, i.company_id, i.department, i.kind, i.subject_table, i.subject_id, i.state,
                (select max(t.created_at) from management_item_transitions t
                  where t.item_id = i.id and t.to_state in ('verifying','monitoring')) as claimed_at
           from management_items i
          where i.company_id = $1 and i.id = $2`,
        [companyId, itemId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: String(row.id),
        companyId: String(row.company_id),
        department: String(row.department),
        kind: String(row.kind),
        subjectTable: String(row.subject_table),
        subjectId: String(row.subject_id),
        state: String(row.state),
        claimedAt: row.claimed_at == null ? null : new Date(String(row.claimed_at)),
      } satisfies ItemRow;
    },

    async readTask(companyId, taskId): Promise<SourceRead<TaskUnderVerification>> {
      try {
        const { rows } = await sql(
          `select t.id, t.title, t.status, t.due_date, t.requires_evidence,
                  (select max(c.created_at) from task_check_ins c where c.task_id = t.id)
                    as last_check_in_at,
                  (select count(*)::int from task_evidence e
                    where e.task_id = t.id and e.verified_by is not null) as verified_evidence_count
             from tasks t
            where t.company_id = $1 and t.id = $2`,
          [companyId, taskId],
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
    },

    async evidenceGeneration(companyId, itemId) {
      const { rows } = await sql(`select public.r1_draft_evidence_digest($1,$2) as d`, [
        companyId,
        itemId,
      ]);
      return String(rows[0]?.d ?? "empty");
    },

    async transition(_companyId, req: TransitionRequest) {
      const { rows } = await sql(
        `select public.r1_draft_transition_item($1,$2,$3,$4,$5,$6,'[]'::jsonb) as r`,
        [req.itemId, req.from, req.to, req.actorId, req.actorType, req.detail],
      );
      return (rows[0]?.r as { ok?: boolean } | undefined)?.ok === true;
    },

    async recordAttempt(a: AttemptRecord) {
      await sql(
        `insert into management_verification_attempts
           (company_id, item_id, attempt_no, outcome, detail, observed_at, generation, actor_type)
         values ($1,$2,$3,$4,$5,$6,$7,'system')`,
        [
          a.companyId, a.itemId, a.attemptNo, a.outcome, a.detail,
          a.observedAt.toISOString(), a.generation,
        ],
      );
      await sql(
        `insert into management_verification_schedule
           (company_id, item_id, attempts, next_attempt_at, last_outcome, last_detail,
            last_attempt_at)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (company_id, item_id) do update
           set attempts        = excluded.attempts,
               next_attempt_at = excluded.next_attempt_at,
               last_outcome    = excluded.last_outcome,
               last_detail     = excluded.last_detail,
               last_attempt_at = excluded.last_attempt_at`,
        [
          a.companyId, a.itemId, a.attemptNo, a.nextAttemptAt.toISOString(),
          a.outcome, a.detail, a.attemptedAt.toISOString(),
        ],
      );
    },
  };
}
