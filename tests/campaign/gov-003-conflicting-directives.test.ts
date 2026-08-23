/**
 * GOV-003 — Conflicting-instruction detection and resolution surface.
 *
 * Management directives can name a target/action, active contradictory directives
 * on the same target are surfaced as conflicts, and an admin can resolve a conflict
 * with a recorded reason.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/directives/page.tsx";
const ACTIONS = "src/app/app/admin/directives/actions.ts";
const MIGRATION = "src/db/migrations/0098_conflicting_directive_resolution.sql";

describe("GOV-003 — Conflicting-instruction detection and resolution", () => {
  const page = readFileSync(PAGE, "utf8");
  const actions = readFileSync(ACTIONS, "utf8");
  const migration = readFileSync(MIGRATION, "utf8");

  it("has a real runtime entrypoint under /app/admin/directives", () => {
    expect(page).toContain('export const metadata = { title: "Directives');
    expect(page).toContain("export default async function DirectivesPage");
    expect(page).toContain("requireAdmin()");
  });

  it("extends management_directives with target_type, target_id and action", () => {
    expect(migration).toContain("alter table management_directives add column if not exists target_type text");
    expect(migration).toContain("alter table management_directives add column if not exists target_id text");
    expect(migration).toContain("alter table management_directives add column if not exists action text");
    expect(migration).toContain("management_directives_action_check");
    expect(migration).toContain("'approve'");
    expect(migration).toContain("'reject'");
    expect(migration).toContain("'hold'");
    expect(migration).toContain("'proceed'");
    expect(migration).toContain("'stop'");
  });

  it("adds a management_directive_conflicts table with status, resolution and updated_at trigger", () => {
    expect(migration).toContain("create table if not exists management_directive_conflicts");
    expect(migration).toContain("directive_a_id uuid not null references management_directives(id)");
    expect(migration).toContain("directive_b_id uuid not null references management_directives(id)");
    expect(migration).toContain("status text not null default 'open' check (status in ('open','resolved'))");
    expect(migration).toContain("management_directive_conflicts_pair_uidx");
    expect(migration).toContain("management_directive_conflicts_updated_at");
  });

  it("auto-detects conflicts via a trigger when directives become active", () => {
    expect(migration).toContain("create or replace function public.detect_management_directive_conflicts()");
    expect(migration).toContain("management_directives_conflict_detection");
    expect(migration).toContain("after insert or update on management_directives");
  });

  it("protects conflicts with company-isolated reads and capability-gated writes", () => {
    expect(migration).toContain("alter table management_directive_conflicts enable row level security");
    expect(migration).toContain("management_directive_conflicts_read on management_directive_conflicts for select using");
    expect(migration).toContain("has_company_access(company_id)");
    expect(migration).toContain("has_capability(company_id, 'admin.directive.manage')");
  });

  it("exposes a conflicts section on the directives page", () => {
    expect(page).toContain('id="conflicts"');
    expect(page).toContain("Conflicts");
    expect(page).toContain('from("management_directive_conflicts")');
    expect(page).toContain("resolveDirectiveConflict");
  });

  it("provides a resolve action that writes an audit event", () => {
    expect(actions).toContain("export async function resolveDirectiveConflict");
    expect(actions).toContain('action: "management_directive_conflict.resolved"');
    expect(actions).toContain("writeAudit");
  });

  it("includes target_type, target_id and action inputs in the new-directive form", () => {
    expect(page).toContain('name="target_type"');
    expect(page).toContain('name="target_id"');
    expect(page).toContain('name="action"');
  });
});
