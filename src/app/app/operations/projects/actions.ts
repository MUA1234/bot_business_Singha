"use server";

import { revalidatePath } from "next/cache";
import { requireProfile } from "@/lib/auth";
import { supabaseWriteClient } from "@/lib/supabase/read";
import { writeAudit } from "@/lib/audit";

const PROJECT_STATUSES = new Set(["active", "on_hold", "completed", "cancelled"]);
const RISK_IMPACTS = new Set(["low", "medium", "high", "critical"]);
const RISK_LIKELIHOODS = new Set(["low", "medium", "high", "critical"]);
const RISK_STATUSES = new Set(["open", "mitigated", "accepted", "closed"]);
const DECISION_STATUSES = new Set(["pending", "decided", "reversed"]);

async function requireOps() {
  const p = await requireProfile();
  if (!p.isAdmin && p.department !== "operations") throw new Error("Not allowed");
  return p;
}

function isUUID(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

/** Operations staff or an admin may update a project's lifecycle status. */
export async function updateProjectStatus(formData: FormData): Promise<void> {
  const p = await requireOps();

  const id = String(formData.get("project_id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!id || !PROJECT_STATUSES.has(status)) return;

  // Load current status for the audit payload; fail closed if not in company.
  const { data: project } = await supabaseWriteClient()
    .from("projects")
    .select("status")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!project) return;

  const { error } = await supabaseWriteClient()
    .from("projects")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project.status_updated",
    entityType: "project",
    entityId: id,
    payload: { from: project.status, to: status },
  });

  revalidatePath(`/app/operations/projects/${id}`);
  revalidatePath("/app/operations/projects");
}

/** Operations staff or an admin may add a project risk. */
export async function createProjectRisk(formData: FormData): Promise<void> {
  const p = await requireOps();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim() || null;
  const ownerId = String(formData.get("owner_id") ?? "").trim() || null;
  const mitigation = String(formData.get("mitigation") ?? "").trim() || null;
  const impact = String(formData.get("impact") ?? "medium").trim();
  const likelihood = String(formData.get("likelihood") ?? "medium").trim();
  const status = String(formData.get("status") ?? "open").trim();
  const reviewDate = String(formData.get("review_date") ?? "").trim() || null;

  if (!isUUID(projectId) || !title || !RISK_IMPACTS.has(impact) || !RISK_LIKELIHOODS.has(likelihood) || !RISK_STATUSES.has(status)) {
    return;
  }

  const db = supabaseWriteClient();
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!project) return;

  const { error, data } = await db
    .from("project_risks")
    .insert({
      company_id: p.companyId,
      project_id: projectId,
      title,
      description,
      owner_id: ownerId && isUUID(ownerId) ? ownerId : null,
      mitigation,
      impact,
      likelihood,
      status,
      review_date: reviewDate,
    })
    .select("id")
    .single();
  if (error || !data) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project_risk.created",
    entityType: "project_risk",
    entityId: data.id,
    payload: { project_id: projectId, title, impact, likelihood, status },
  });
  revalidatePath(`/app/operations/projects/${projectId}`);
}

/** Operations staff or an admin may update a project risk status. */
export async function updateProjectRiskStatus(formData: FormData): Promise<void> {
  const p = await requireOps();
  const id = String(formData.get("risk_id") ?? "").trim();
  const status = String(formData.get("status") ?? "").trim();
  if (!isUUID(id) || !RISK_STATUSES.has(status)) return;

  const db = supabaseWriteClient();
  const { data: risk } = await db
    .from("project_risks")
    .select("project_id, status")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!risk) return;

  const { error } = await db
    .from("project_risks")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project_risk.status_updated",
    entityType: "project_risk",
    entityId: id,
    payload: { project_id: risk.project_id, from: risk.status, to: status },
  });
  revalidatePath(`/app/operations/projects/${risk.project_id}`);
}

/** Operations staff or an admin may add a project decision. */
export async function createProjectDecision(formData: FormData): Promise<void> {
  const p = await requireOps();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const context = String(formData.get("context") ?? "").trim() || null;
  const optionsJson = String(formData.get("options") ?? "[]").trim();
  let options: unknown;
  try {
    options = JSON.parse(optionsJson);
    if (!Array.isArray(options)) return;
  } catch {
    return;
  }

  if (!isUUID(projectId) || !title) return;

  const db = supabaseWriteClient();
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!project) return;

  const { error, data } = await db
    .from("project_decisions")
    .insert({
      company_id: p.companyId,
      project_id: projectId,
      title,
      context,
      options,
    })
    .select("id")
    .single();
  if (error || !data) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project_decision.created",
    entityType: "project_decision",
    entityId: data.id,
    payload: { project_id: projectId, title },
  });
  revalidatePath(`/app/operations/projects/${projectId}`);
}

/** Operations staff or an admin may record a decision outcome. */
export async function decideProjectDecision(formData: FormData): Promise<void> {
  const p = await requireOps();
  const id = String(formData.get("decision_id") ?? "").trim();
  const optionId = String(formData.get("option_id") ?? "").trim() || null;
  const rationale = String(formData.get("rationale") ?? "").trim() || null;
  const status = String(formData.get("status") ?? "").trim();
  if (!isUUID(id) || !DECISION_STATUSES.has(status)) return;

  const db = supabaseWriteClient();
  const { data: decision } = await db
    .from("project_decisions")
    .select("project_id, options, status")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!decision) return;

  const options = Array.isArray(decision.options) ? (decision.options as Array<{ id: string }>) : [];
  if (optionId && !options.some((o) => o.id === optionId)) return;

  const { error } = await db
    .from("project_decisions")
    .update({
      status,
      decided_option_id: optionId,
      rationale,
      decided_by: p.userId,
      decided_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project_decision.decided",
    entityType: "project_decision",
    entityId: id,
    payload: { project_id: decision.project_id, from: decision.status, to: status, option_id: optionId },
  });
  revalidatePath(`/app/operations/projects/${decision.project_id}`);
}

/** Operations staff or an admin may add a project scenario. */
export async function createProjectScenario(formData: FormData): Promise<void> {
  const p = await requireOps();
  const projectId = String(formData.get("project_id") ?? "").trim();
  const title = String(formData.get("title") ?? "").trim();
  const bestCaseTotal = String(formData.get("best_case_total") ?? "0").trim();
  const expectedTotal = String(formData.get("expected_total") ?? "0").trim();
  const worstCaseTotal = String(formData.get("worst_case_total") ?? "0").trim();
  const currency = String(formData.get("currency") ?? "").trim() || "LKR";

  if (!isUUID(projectId) || !title) return;
  if (Number.isNaN(Number(bestCaseTotal)) || Number.isNaN(Number(expectedTotal)) || Number.isNaN(Number(worstCaseTotal))) return;

  const db = supabaseWriteClient();
  const { data: project } = await db
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!project) return;

  const { error, data } = await db
    .from("project_scenarios")
    .insert({
      company_id: p.companyId,
      project_id: projectId,
      title,
      best_case_total: bestCaseTotal,
      expected_total: expectedTotal,
      worst_case_total: worstCaseTotal,
      currency,
    })
    .select("id")
    .single();
  if (error || !data) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project_scenario.created",
    entityType: "project_scenario",
    entityId: data.id,
    payload: { project_id: projectId, title, best_case_total: bestCaseTotal, expected_total: expectedTotal, worst_case_total: worstCaseTotal, currency },
  });
  revalidatePath(`/app/operations/projects/${projectId}`);
}

/** Operations staff or an admin may choose a project scenario. */
export async function chooseProjectScenario(formData: FormData): Promise<void> {
  const p = await requireOps();
  const id = String(formData.get("scenario_id") ?? "").trim();
  if (!isUUID(id)) return;

  const db = supabaseWriteClient();
  const { data: scenario } = await db
    .from("project_scenarios")
    .select("project_id")
    .eq("id", id)
    .eq("company_id", p.companyId)
    .maybeSingle();
  if (!scenario) return;

  // Only one chosen scenario per project.
  await db
    .from("project_scenarios")
    .update({ chosen: false, updated_at: new Date().toISOString() })
    .eq("project_id", scenario.project_id)
    .eq("company_id", p.companyId);

  const { error } = await db
    .from("project_scenarios")
    .update({ chosen: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("company_id", p.companyId);
  if (error) return;

  await writeAudit({
    companyId: p.companyId,
    actorId: p.userId,
    action: "project_scenario.chosen",
    entityType: "project_scenario",
    entityId: id,
    payload: { project_id: scenario.project_id },
  });
  revalidatePath(`/app/operations/projects/${scenario.project_id}`);
}
