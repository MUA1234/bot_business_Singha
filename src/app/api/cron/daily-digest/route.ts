/**
 * Scheduled monitoring digest (Architecture V2 change plan §13). A cron-triggered
 * sweep that, per company, counts overdue tasks, overdue obligations, upcoming
 * renewals and overloaded staff, and notifies each admin. It ONLY creates
 * notifications — it never executes a business action, moves money, or replies to a
 * customer. Secured by CRON_SECRET (Vercel Cron sends it as a Bearer token).
 */
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { createNotification } from "@/lib/notify";
import { buildDigestBody } from "@/management/ai-manager/digest";

export const runtime = "nodejs";

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function count(run: () => Promise<{ count: number | null }>): Promise<number> {
  try {
    return (await run()).count ?? 0;
  } catch {
    return 0;
  }
}

export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }

  const db = supabaseAdmin();
  const today = iso(0);
  const soon = iso(30);

  // Companies that have at least one active admin to notify.
  const { data: admins } = await db.from("profiles").select("id, company_id").eq("is_admin", true).eq("is_active", true);
  const adminsByCompany = new Map<string, string[]>();
  for (const a of admins ?? []) {
    const list = adminsByCompany.get(a.company_id) ?? [];
    list.push(a.id);
    adminsByCompany.set(a.company_id, list);
  }

  let notified = 0;
  const summary: { company: string; digest: string }[] = [];

  for (const [companyId, adminIds] of adminsByCompany) {
    const [overdueTasks, overdueObligations, lic, vdoc, contracts, overloaded] = await Promise.all([
      count(() => db.from("tasks").select("id", { count: "exact", head: true }).eq("company_id", companyId).lt("due_date", today).not("status", "in", "(completed,cancelled)") as any),
      count(() => db.from("obligations").select("id", { count: "exact", head: true }).eq("company_id", companyId).lt("due_date", today).eq("status", "open") as any),
      count(() => db.from("licences").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("expiry_date", today).lte("expiry_date", soon) as any),
      count(() => db.from("vehicle_documents").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("expiry_date", today).lte("expiry_date", soon) as any),
      count(() => db.from("contracts").select("id", { count: "exact", head: true }).eq("company_id", companyId).gte("renewal_date", today).lte("renewal_date", soon) as any),
      count(() => db.from("capacity_snapshots").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("status", "overloaded") as any),
    ]);

    const body = buildDigestBody({ overdueTasks, overdueObligations, expiringSoon: lic + vdoc + contracts, overloadedStaff: overloaded });
    if (!body) continue;

    for (const adminId of adminIds) {
      await createNotification({ companyId, recipientId: adminId, type: "digest", title: "Daily digest", body, link: "/app/command" });
      notified++;
    }
    summary.push({ company: companyId, digest: body });
  }

  return NextResponse.json({ ok: true, notified, companies: summary });
}
