import { supabaseReadClient } from "@/lib/supabase/read";
import { renewalStatus } from "@/management/ai-manager/renewals";
import { RisksPanelContent, type PlainObject } from "./RisksPanelContent";

export { RisksPanelContent as RisksContent } from "./RisksPanelContent";

export async function loadRisksData(companyId: string, _userId?: string): Promise<PlainObject> {
  const now = new Date();

  let rows: any[] = [];
  let profiles: any[] = [];
  try {
    const db = supabaseReadClient();
    const [{ data: risks }, { data: people }] = await Promise.all([
      db
        .from("risks")
        .select("id, title, description, owner_id, mitigation, evidence, review_date, status")
        .eq("company_id", companyId)
        .order("review_date", { ascending: true, nullsFirst: false })
        .limit(300),
      db.from("profiles").select("id, full_name").eq("company_id", companyId).limit(200),
    ]);
    rows = risks ?? [];
    profiles = people ?? [];
  } catch {
    rows = [];
    profiles = [];
  }

  const byProfile = new Map(profiles.map((x) => [x.id, x.full_name ?? "—"]));

  const risks = rows.map((r) => {
    const st = renewalStatus(r.review_date ?? null, now, 45);
    const badge = st === "expired" ? "danger" : st === "due_soon" ? "warn" : "";
    return {
      id: r.id,
      title: r.title,
      description: r.description,
      ownerName: byProfile.get(r.owner_id) ?? "—",
      mitigation: r.mitigation,
      evidence: r.evidence,
      reviewDate: r.review_date,
      status: r.status,
      reviewBadgeClass: badge,
    };
  });

  return { risks, profiles } as PlainObject;
}

export default async function RisksPanel({
  companyId,
  userId,
  embedded,
}: {
  companyId: string;
  userId?: string;
  embedded?: boolean;
}) {
  const data = await loadRisksData(companyId, userId);
  return <RisksPanelContent data={data} embedded={embedded ?? false} />;
}
