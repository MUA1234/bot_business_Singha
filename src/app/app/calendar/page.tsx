/**
 * Calendar & commitments (§33).
 *
 * A planning surface over the dates the business has ALREADY committed to.
 * There is no calendar table, no new scheduling model and no invented event:
 * every entry is an existing record with a date on it — a task due date, an
 * obligation, a licence expiry, a contract renewal, an insurance expiry, an
 * expected purchase-order payment, an expected commitment settlement, or
 * approved leave.
 *
 * Records with NO date are counted and reported rather than placed. A date that
 * was never recorded is a gap in the data, and hiding it would make this screen
 * look complete when it is not.
 *
 * Deliberately conventional where conventional is stronger (§33): this is a
 * readable agenda, not a spatial effect applied to a date grid.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";
import { supabaseReadClient } from "@/lib/supabase/read";
import {
  buildCommitmentCalendar,
  type CommitmentKind,
  type CommitmentSource,
} from "@/modules/calendar/commitments";
import { fmtNumber } from "@/lib/format";
import { Icon } from "@/components/Icon";
import { Matter, PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Calendar — Singha Central" };

async function rows<T>(run: () => Promise<{ data: T[] | null }>): Promise<T[]> {
  try {
    return (await run()).data ?? [];
  } catch {
    return [];
  }
}

const KIND_ICON: Record<CommitmentKind, string> = {
  task: "list-todo",
  obligation: "gavel",
  licence: "shield",
  contract: "scroll-text",
  insurance: "shield-alert",
  "purchase-order": "package",
  commitment: "banknote",
  leave: "user-round",
};

const KIND_LABEL: Record<CommitmentKind, string> = {
  task: "Task due",
  obligation: "Obligation",
  licence: "Licence expiry",
  contract: "Contract renewal",
  insurance: "Insurance expiry",
  "purchase-order": "Expected payment",
  commitment: "Expected settlement",
  leave: "Leave",
};

function dayLabel(date: string, today: string): string {
  if (date === today) return "Today";
  const d = new Date(`${date}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  const diff = Math.round((d.getTime() - t.getTime()) / 86_400_000);
  if (diff === 1) return "Tomorrow";
  if (diff === -1) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

export default async function CalendarPage() {
  const p = await requireProfile();
  const db = supabaseReadClient();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const cid = p.companyId;

  const [tasks, obligations, licences, contracts, insurances, pos, commitments, leave] =
    await Promise.all([
      rows<any>(() =>
        db.from("tasks").select("id, title, due_date, status").eq("company_id", cid).limit(500) as any,
      ),
      rows<any>(() =>
        db.from("obligations").select("id, description, due_date, status").eq("company_id", cid).limit(300) as any,
      ),
      rows<any>(() =>
        db.from("licences").select("id, name, expiry_date").eq("company_id", cid).limit(300) as any,
      ),
      rows<any>(() =>
        db.from("contracts").select("id, title, renewal_date").eq("company_id", cid).limit(300) as any,
      ),
      rows<any>(() =>
        db.from("insurances").select("id, policy_name, expiry_date, status").eq("company_id", cid).limit(300) as any,
      ),
      rows<any>(() =>
        db
          .from("purchase_orders")
          .select("id, po_number, expected_payment_date, status")
          .eq("company_id", cid)
          .limit(300) as any,
      ),
      rows<any>(() =>
        db
          .from("commitments")
          .select("id, description, expected_settlement_date, status")
          .eq("company_id", cid)
          .limit(300) as any,
      ),
      rows<any>(() =>
        db
          .from("leave_requests")
          .select("id, start_date, end_date, status, profile_id")
          .eq("company_id", cid)
          .eq("status", "approved")
          .limit(300) as any,
      ),
    ]);

  const closedTask = new Set(["completed", "cancelled"]);

  const sources: { kind: CommitmentKind; items: CommitmentSource[] }[] = [
    {
      kind: "task",
      items: tasks.map((t: any): CommitmentSource => ({
        id: t.id,
        date: t.due_date,
        title: t.title,
        detail: t.status?.replace(/_/g, " "),
        href: `/app/operations/tasks/${t.id}`,
        closed: closedTask.has(t.status),
      })),
    },
    {
      kind: "obligation",
      items: obligations.map((o: any): CommitmentSource => ({
        id: o.id,
        date: o.due_date,
        title: o.description,
        href: "/app/legal/obligations",
        closed: o.status === "done",
      })),
    },
    {
      kind: "licence",
      items: licences.map((l: any): CommitmentSource => ({
        id: l.id,
        date: l.expiry_date,
        title: l.name,
        href: "/app/legal/licences",
      })),
    },
    {
      kind: "contract",
      items: contracts.map((c: any): CommitmentSource => ({
        id: c.id,
        date: c.renewal_date,
        title: c.title,
        href: "/app/legal/contracts",
      })),
    },
    {
      kind: "insurance",
      items: insurances.map((i: any): CommitmentSource => ({
        id: i.id,
        date: i.expiry_date,
        title: i.policy_name,
        href: "/app/legal/insurances",
        closed: i.status === "cancelled",
      })),
    },
    {
      kind: "purchase-order",
      items: pos.map((po: any): CommitmentSource => ({
        id: po.id,
        date: po.expected_payment_date,
        title: po.po_number ?? "Purchase order",
        href: `/app/procurement/purchase-orders/${po.id}`,
        closed: po.status === "closed" || po.status === "cancelled",
      })),
    },
    {
      kind: "commitment",
      items: commitments.map((c: any): CommitmentSource => ({
        id: c.id,
        date: c.expected_settlement_date,
        title: c.description,
        href: "/app/finance/commitments",
        closed: c.status === "settled",
      })),
    },
    {
      kind: "leave",
      items: leave.map((l: any): CommitmentSource => ({
        id: l.id,
        date: l.start_date,
        title: "Approved leave begins",
        detail: `until ${l.end_date}`,
        href: "/app/hr/leave",
        closed: true,
      })),
    },
  ];

  const calendar = buildCommitmentCalendar({ now, sources, horizonDays: 60, lookbackDays: 30 });
  const undatedTotal = calendar.undated.reduce((s, u) => s + u.count, 0);
  const upcoming = calendar.days.filter((d) => d.date >= today);
  const past = calendar.days.filter((d) => d.date < today).reverse();

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Work"
        title="Calendar & commitments"
        lede="Every date this company has already committed to, gathered from the records that carry one. Nothing here is a separate calendar entry — each line is the record itself."
        actions={
          <>
            <Link className="btn ghost sm" href="/app/operations/tasks">Work</Link>
            <Link className="btn ghost sm" href="/app/legal/obligations">Obligations</Link>
          </>
        }
      />

      {calendar.overdue.length > 0 && (
        <>
          <Section title="Already past" meta={`${calendar.overdue.length} missed`} />
          <div className="field-matters">
            <Matter
              kind="Missed commitments"
              kindIcon="alert-triangle"
              band="critical"
              title={
                calendar.overdue.length === 1
                  ? "A commitment passed its date without being closed"
                  : `${calendar.overdue.length} commitments passed their date without being closed`
              }
              facts={calendar.overdue.slice(0, 4).map((e) => ({
                k: KIND_LABEL[e.kind],
                // The title may wrap; the date may not. An ISO date breaks at
                // its own hyphens ("2026-" / "08-16"), which reads as two
                // separate values rather than one date.
                v: (
                  <>
                    {e.title} · <span className="nowrap">{e.date}</span>
                  </>
                ),
              }))}
              footer={<Signal kind="critical">Each of these was a promise to someone</Signal>}
            />
          </div>
        </>
      )}

      <Section
        title="Position"
        meta="60 days forward, 30 days back"
      />
      <div className="grid cols-3">
        <div className="card stat">
          <div className="k">Dated commitments</div>
          <div className="v">{fmtNumber(calendar.totalPlaced)}</div>
          <div className="d">Placed on the surface below</div>
        </div>
        <div className="card stat">
          <div className="k">Missed</div>
          <div className="v">{fmtNumber(calendar.overdue.length)}</div>
          <div className="d">
            {calendar.overdue.length > 0 ? (
              <Signal kind="critical">Past their date and still open</Signal>
            ) : (
              <Signal kind="ok">Nothing missed</Signal>
            )}
          </div>
        </div>
        <div className="card stat">
          <div className="k">No date recorded</div>
          <div className="v">{fmtNumber(undatedTotal)}</div>
          <div className="d">
            {undatedTotal > 0 ? (
              <Signal kind="warn">Cannot be planned for</Signal>
            ) : (
              <Signal kind="ok">Everything is dated</Signal>
            )}
          </div>
        </div>
      </div>

      {/* ── THE AGENDA ──────────────────────────────────────────────────── */}
      <Section title="Ahead" meta={`${upcoming.length} day(s) with commitments`} />
      {upcoming.length === 0 ? (
        <StateNote kind="empty" title="Nothing is scheduled in the next 60 days">
          No record with a date falls inside the horizon. That is not the same as having nothing to
          do — see the undated count above.
        </StateNote>
      ) : (
        <div className="card pad-lg">
          <div className="timeline">
            {upcoming.map((day) => (
              <div
                className="tl-item"
                data-when={day.date === today ? "current" : "future"}
                key={day.date}
              >
                <span className="tl-node" aria-hidden="true">
                  <i />
                </span>
                <div className="tl-when">{dayLabel(day.date, today)}</div>
                <div className="stack gap-1 mt-1">
                  {day.entries.map((e) => {
                    const inner = (
                      <>
                        <span className="node-card-ico" aria-hidden="true">
                          <Icon name={KIND_ICON[e.kind]} size={16} strokeWidth={1.6} />
                        </span>
                        <span className="node-card-text">
                          <span className="node-card-title">{e.title}</span>
                          <span className="node-card-note">
                            {KIND_LABEL[e.kind]}
                            {e.detail ? ` · ${e.detail}` : ""}
                          </span>
                        </span>
                        {e.overdue && <Signal kind="critical">Missed</Signal>}
                      </>
                    );
                    return e.href ? (
                      <Link key={e.id} href={e.href} className="node-card">
                        {inner}
                      </Link>
                    ) : (
                      <div key={e.id} className="node-card">
                        {inner}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {past.length > 0 && (
        <>
          <Section title="Behind" meta="the last 30 days" />
          <div className="card pad-lg">
            <div className="timeline">
              {past.map((day) => (
                <div className="tl-item" data-when="past" key={day.date}>
                  <span className="tl-node" aria-hidden="true">
                    <i />
                  </span>
                  <div className="tl-when">{dayLabel(day.date, today)}</div>
                  <div className="stack gap-1 mt-1">
                    {day.entries.map((e) => {
                      const inner = (
                        <>
                          <span className="node-card-text">
                            <span className="node-card-title">{e.title}</span>
                            <span className="node-card-note">{KIND_LABEL[e.kind]}</span>
                          </span>
                          {e.overdue && <Signal kind="critical">Still open</Signal>}
                        </>
                      );
                      return e.href ? (
                        <Link key={e.id} href={e.href} className="node-card">
                          {inner}
                        </Link>
                      ) : (
                        <div key={e.id} className="node-card">
                          {inner}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {undatedTotal > 0 && (
        <>
          <Section title="Recorded with no date" meta="cannot be planned for" />
          <div className="card">
            <StateNote kind="partial" title={`${undatedTotal} record(s) carry no date`}>
              These exist in the system but cannot appear on any calendar until a date is recorded
              against them. They are listed here so the gap is visible rather than silent.
            </StateNote>
            <div className="grid cols-3 mt-3">
              {calendar.undated.map((u) => (
                <div className="card stat" key={u.kind}>
                  <div className="k">{KIND_LABEL[u.kind]}</div>
                  <div className="v">{fmtNumber(u.count)}</div>
                  <div className="d">No date recorded</div>
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
