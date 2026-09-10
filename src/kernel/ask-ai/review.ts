/**
 * R2D — reading someone else's saved guidance.
 *
 * A saved answer is a hazard the moment access changes. It contains SENTENCES derived from records
 * — an amount, a customer's situation, a deadline — and those sentences do not re-check anything
 * when they are read back. Storing citations as references rather than copies protects the
 * records; it does not protect the prose that quoted them.
 *
 * So a saved answer is re-authorised at READ time, against the person reading it now:
 *
 *   * the thread requires `management.ask_ai.review` unless it is the reader's own;
 *   * every citation is re-checked against what the READER may currently see;
 *   * if any material citation is no longer accessible, the answer TEXT is withheld — because
 *     the facts it repeats came from that record;
 *   * the withholding says nothing about the record: not its title, not its existence, not how
 *     many there were.
 *
 * The last point is the subtle one. "This answer cites 3 records you cannot see" is itself a
 * disclosure: it confirms records exist and counts them. The restricted state is deliberately
 * uninformative.
 */
import type { Db } from "./retrieval";
import type { MembershipId, CompanyId } from "./identity";

export type ThreadAccess =
  | "owner"
  | "reviewer"
  | "denied";

export type ReviewOutcome =
  | { state: "visible"; turns: VisibleTurn[] }
  | { state: "restricted"; reason: RestrictedReason }
  | { state: "denied" };

/** Why an answer's text is withheld. A code, carrying no information about the records. */
export type RestrictedReason = "evidence_not_accessible" | "thread_expired";

export interface VisibleTurn {
  role: "user" | "assistant";
  content: string;
  language: string;
  createdAt: string;
  /** Only citations the READER may currently open. */
  citations: { sourceTable: string; sourceId: string }[];
}

export interface ReviewRequest {
  threadId: string;
  companyId: CompanyId;
  /** The person reading, now — not the person who asked. */
  viewerMembershipId: MembershipId;
  capabilities: ReadonlySet<string>;
}

export const REVIEW_CAPABILITY = "management.ask_ai.review";

/**
 * Can this reader open the thread at all?
 *
 * Company scope first, then ownership, then the capability. A manager's job title is never
 * consulted — that decision was explicit, and it is enforced here rather than assumed.
 */
export async function resolveThreadAccess(
  db: Db, req: ReviewRequest,
): Promise<{ access: ThreadAccess; expired: boolean }> {
  const { data, error } = await db
    .from("ask_ai_threads")
    .select("id, company_id, membership_id, retention_status, expires_at")
    .eq("id", req.threadId)
    .eq("company_id", req.companyId)
    .maybeSingle();

  // A thread in another company is indistinguishable from one that does not exist. Both are
  // simply "denied" — anything else would confirm it is out there.
  if (error || !data) return { access: "denied", expired: false };

  const row = data as {
    membership_id: string; retention_status: string; expires_at: string;
  };
  const expired =
    row.retention_status !== "active" || Date.parse(row.expires_at) <= Date.now();

  if (row.membership_id === req.viewerMembershipId) return { access: "owner", expired };
  if (req.capabilities.has(REVIEW_CAPABILITY)) return { access: "reviewer", expired };
  return { access: "denied", expired };
}

/**
 * Which of these records can the reader open RIGHT NOW?
 *
 * Asked as the reader, per record, at read time. A citation stored months ago says nothing about
 * today's access, and that gap is the whole reason this function exists.
 */
async function accessibleCitations(
  db: Db,
  companyId: string,
  refs: readonly { sourceTable: string; sourceId: string }[],
  canRead: (table: string, id: string) => Promise<boolean>,
): Promise<Set<string>> {
  const ok = new Set<string>();
  for (const r of refs) {
    try {
      if (await canRead(r.sourceTable, r.sourceId)) ok.add(`${r.sourceTable}:${r.sourceId}`);
    } catch {
      // An unreadable check is treated as no access. Failing open here would hand over the
      // answer text on a transient error.
    }
  }
  void db; void companyId;
  return ok;
}

/**
 * Read a saved thread as a particular person.
 *
 * `canRead` is supplied by the caller because only it knows how to ask "may THIS person open
 * THIS record" — through the same authorisation the rest of the application uses, not a copy of
 * it living here.
 */
export async function readThreadForViewer(
  db: Db,
  req: ReviewRequest,
  canRead: (table: string, id: string) => Promise<boolean>,
): Promise<ReviewOutcome> {
  const { access, expired } = await resolveThreadAccess(db, req);
  if (access === "denied") return { state: "denied" };
  if (expired) return { state: "restricted", reason: "thread_expired" };

  const { data: turnRows, error } = await db
    .from("ask_ai_turns")
    .select("id, role, content, language, created_at")
    .eq("thread_id", req.threadId)
    .eq("company_id", req.companyId)
    .order("created_at", { ascending: true });
  if (error) return { state: "denied" };

  const turns = (turnRows ?? []) as Array<Record<string, unknown>>;
  const visible: VisibleTurn[] = [];

  for (const t of turns) {
    const { data: citeRows } = await db
      .from("ask_ai_citations")
      .select("source_table, source_id")
      .eq("turn_id", String(t.id))
      .eq("company_id", req.companyId);

    const refs = ((citeRows ?? []) as Array<Record<string, unknown>>).map((c) => ({
      sourceTable: String(c.source_table),
      sourceId: String(c.source_id),
    }));

    const allowed = await accessibleCitations(db, req.companyId, refs, canRead);

    // An ASSISTANT turn repeats facts drawn from its citations. If even one is now closed to
    // this reader, the sentences cannot be shown — they are the record's content in another
    // form. The user's own question is not derived from a record and is not withheld on that
    // basis, though it is still governed by the thread-level access above.
    if (t.role === "assistant" && refs.length > 0 && allowed.size < refs.length) {
      return { state: "restricted", reason: "evidence_not_accessible" };
    }

    visible.push({
      role: t.role as "user" | "assistant",
      content: String(t.content),
      language: String(t.language),
      createdAt: String(t.created_at),
      citations: refs.filter((r) => allowed.has(`${r.sourceTable}:${r.sourceId}`)),
    });
  }

  return { state: "visible", turns: visible };
}

/**
 * What a restricted outcome tells the reader.
 *
 * Deliberately the same sentence whatever the cause. A message that varied — "you cannot see 2 of
 * the cited invoices" — would leak the existence, the count and the type of the records it was
 * meant to protect.
 */
export function restrictedMessage(): string {
  return (
    "This guidance cannot be shown. It relies on records you are not currently able to access, " +
    "so its content is withheld."
  );
}
