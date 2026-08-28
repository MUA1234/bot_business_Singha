/**
 * Notifications (§10 UX). A signed-in employee's own notifications — leave decisions,
 * approvals, task assignments. Read-only + mark-read. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { unreadCount } from "@/lib/notify";
import { markRead, markAllRead } from "./actions";
import { Button } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";
import { PageHead, Section, Signal, StateNote } from "@/components/os/primitives";

export const metadata = { title: "Notifications — Singha Central" };

export default async function NotificationsPage() {
  const p = await requireProfile();

  let rows: any[] = [];
  try {
    rows = (await supabaseReadClient().from("notifications")
      .select("id, type, title, body, link, is_read, created_at")
      .eq("company_id", p.companyId).eq("recipient_id", p.userId)
      .order("created_at", { ascending: false }).limit(100)).data ?? [];
  } catch {
    rows = [];
  }
  const unread = unreadCount(rows);

  return (
    <div className="stack" style={{ gap: "var(--sp-2)" }}>
      <PageHead
        eyebrow="Communications"
        title="Notifications"
        lede="What the system has raised for you personally. Nothing here is a broadcast — each one was addressed to you because a record changed that you are accountable for."
        actions={
          unread > 0 ? (
            <form action={markAllRead}>
              <Button variant="ghost" size="sm" type="submit">
                Mark all read
              </Button>
            </form>
          ) : undefined
        }
      />

      <Section
        title={unread > 0 ? "Unread" : "All caught up"}
        meta={unread > 0 ? `${unread} unread of ${rows.length}` : `${rows.length} in total`}
      />

      {rows.length === 0 ? (
        <StateNote kind="empty" title="No notifications yet">
          When something needs your attention it will appear here. An empty list means nothing has
          been raised for you — not that nothing has happened.
        </StateNote>
      ) : (
        <div className="card">
          <div className="stack gap-1">
            {rows.map((n) => {
              const body = (
                <>
                  <span className="node-card-text">
                    <span className="node-card-title">{n.title}</span>
                    {n.body && <span className="node-card-note">{n.body}</span>}
                    <span className="node-card-note dim">{fmtDateTime(n.created_at)}</span>
                  </span>
                  {!n.is_read && <Signal kind="info">Unread</Signal>}
                </>
              );
              return (
                <div
                  key={n.id}
                  className="row gap-2"
                  style={{ alignItems: "stretch", opacity: n.is_read ? 0.62 : 1 }}
                >
                  {n.link ? (
                    <Link href={n.link} className="node-card" style={{ flex: 1 }}>
                      {body}
                    </Link>
                  ) : (
                    <div className="node-card" style={{ flex: 1 }}>
                      {body}
                    </div>
                  )}
                  {!n.is_read && (
                    <form action={markRead} style={{ display: "flex", alignItems: "center" }}>
                      <input type="hidden" name="id" value={n.id} />
                      <Button variant="ghost" size="sm" type="submit">
                        Read
                      </Button>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
