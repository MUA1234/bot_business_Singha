/**
 * Notifications (§10 UX). A signed-in employee's own notifications — leave decisions,
 * approvals, task assignments. Read-only + mark-read. Company-scoped, graceful.
 */
import Link from "next/link";
import { requireProfile } from "@/lib/auth";

import { supabaseReadClient } from "@/lib/supabase/read";
import { unreadCount } from "@/lib/notify";
import { markRead, markAllRead } from "./actions";
import { Card, CardHeader, CardBody, Button, EmptyState } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

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
    <div className="stack gap-3">
      <Card>
        <CardHeader
          title="Notifications"
          subtitle={unread > 0 ? `${unread} unread` : "You're all caught up."}
          action={
            unread > 0 && (
              <form action={markAllRead}>
                <Button variant="ghost" size="sm" type="submit">Mark all read</Button>
              </form>
            )
          }
        />
        <CardBody>
          {rows.length === 0 ? (
            <EmptyState title="No notifications yet" description="When something needs your attention, it will show up here." />
          ) : (
            <div className="stack gap-1">
              {rows.map((n) => (
                <div
                  key={n.id}
                  className="row"
                  style={{
                    padding: "10px 6px",
                    borderBottom: "1px solid var(--panel-border)",
                    opacity: n.is_read ? 0.6 : 1,
                    alignItems: "flex-start",
                    justifyContent: "space-between",
                    gap: 12,
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: n.is_read ? 400 : 700 }}>
                      {!n.is_read && <span style={{ color: "var(--accent)" }}>● </span>}
                      {n.link ? <Link href={n.link}>{n.title}</Link> : n.title}
                    </div>
                    {n.body && <div className="small dim">{n.body}</div>}
                    <div className="small dim">{fmtDateTime(n.created_at)}</div>
                  </div>
                  {!n.is_read && (
                    <form action={markRead}>
                      <input type="hidden" name="id" value={n.id} />
                      <Button variant="ghost" size="sm" type="submit">Read</Button>
                    </form>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
