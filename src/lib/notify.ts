/**
 * In-app notifications (Architecture V2 change plan §10 UX). `createNotification` is a
 * best-effort server write (a failure never breaks the triggering action). The pure
 * `unreadCount` is used by the nav/badge and is unit-tested.
 */
import { supabaseAdmin } from "@/lib/supabase/server";

export interface NewNotification {
  companyId: string;
  recipientId: string; // profile id
  type: string; // e.g. "leave_decided", "approval_decided", "task_assigned"
  title: string;
  body?: string | null;
  link?: string | null;
}

export async function createNotification(n: NewNotification): Promise<void> {
  try {
    await supabaseAdmin().from("notifications").insert({
      company_id: n.companyId,
      recipient_id: n.recipientId,
      type: n.type,
      title: n.title,
      body: n.body ?? null,
      link: n.link ?? null,
    });
  } catch (e) {
    console.error("[notify] failed:", (e as Error).message);
  }
}

export interface NotifLike {
  is_read: boolean;
}

/** Count unread notifications. Pure. */
export function unreadCount(list: NotifLike[]): number {
  return list.reduce((n, x) => n + (x.is_read ? 0 : 1), 0);
}
