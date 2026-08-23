/**
 * AIM-007 — AI Guide next actions surface.
 *
 * The task detail page is a real runtime entrypoint that shows persistent, per-task
 * AI guidance with next actions and coaching. Guide messages are company- and task-
 * scoped, visibility-aware (private coaching stays private), and writes are gated to
 * the `ai.guide.manage` capability. The surface lives behind the default-OFF
 * V3_1_AI_GUIDE flag.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/operations/tasks/[id]/page.tsx";
const ACTIONS = "src/app/app/operations/tasks/actions.ts";
const MIGRATION = "src/db/migrations/0097_ai_guide_messages.sql";

describe("AIM-007 — AI Guide next actions surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("has a real runtime entrypoint under /app/operations/tasks/[id]", () => {
    expect(page).toContain('export const metadata = { title: "Task — Singha Central"');
    expect(page).toContain("export default async function TaskDetail");
    expect(page).toContain("requireProfile()");
  });

  it("reads ai_guide_messages scoped by company_id and task_id", () => {
    expect(page).toContain('from("ai_guide_messages")');
    expect(page).toContain('.eq("task_id", task.id)');
    expect(page).toContain('.eq("company_id", p.companyId)');
    expect(page).toContain("proposed_next_action");
    expect(page).toContain("visibility");
  });

  it("has a company- and task-scoped ai_guide_messages table with visibility-aware RLS", () => {
    expect(migration).toContain("create table if not exists ai_guide_messages");
    expect(migration).toContain("company_id uuid not null references companies(id) on delete cascade");
    expect(migration).toContain("task_id uuid not null references tasks(id) on delete cascade");
    expect(migration).toContain("visibility text not null check (visibility in ('task_team','seniors','private'))");
    expect(migration).toContain("alter table ai_guide_messages enable row level security");
    expect(migration).toContain("ai_guide_messages_read on ai_guide_messages for select using");
    expect(migration).toContain("ai.guide.manage");
    expect(migration).toContain("has_capability(company_id, 'ai.guide.manage')");
    expect(migration).toContain("auth.uid() = any(audience_refs)");
  });

  it("provides an audited create action gated to the ai.guide.manage capability and V3_1_AI_GUIDE flag", () => {
    expect(actions).toContain("export async function createAiGuideMessage");
    expect(actions).toContain('isV31FlagEnabled("aiGuide")');
    expect(actions).toContain('requireCapabilityStrict("ai.guide.manage")');
    expect(actions).toContain('from("ai_guide_messages")');
    expect(actions).toContain('action: "ai_guide_message.created"');
    expect(actions).toContain("writeAudit");
  });

  it("renders the AI Guide panel conditionally behind the V3_1_AI_GUIDE flag", () => {
    expect(page).toContain('isV31FlagEnabled("aiGuide")');
    expect(page).toContain("AI Guide");
    expect(page).toContain("Add guide message");
    expect(page).toContain("Private");
    expect(page).toContain("Seniors");
  });
});
