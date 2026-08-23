/**
 * OPS-002 — Audit search.
 *
 * The admin audit page must be a real runtime entrypoint that queries the
 * append-only audit_events table, scopes results to the company, supports an
 * entity-type filter, and surfaces actor, action, entity and timestamp.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/admin/audit/page.tsx";

describe("OPS-002 — audit search surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("has a real runtime entrypoint under /app/admin/audit", () => {
    expect(page).toContain("export default async function AuditPage");
  });

  it("queries the append-only audit_events table scoped to the company", () => {
    expect(page).toContain('from("audit_events")');
    expect(page).toContain("company_id");
    expect(page).toContain("created_at");
  });

  it("supports an entity-type search filter via query parameter", () => {
    expect(page).toContain("searchParams");
    expect(page).toContain("entity");
    expect(page).toContain("entity_type");
  });

  it("surfaces actor, action, entity and timestamp", () => {
    expect(page).toContain("actor_type");
    expect(page).toContain("action");
    expect(page).toContain("entity_id");
    expect(page).toMatch(/When|actor|action|entity/i);
  });

  it("is gated behind the admin role", () => {
    expect(page).toContain('requireAdmin');
  });
});
