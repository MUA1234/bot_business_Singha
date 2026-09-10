/**
 * MEM-001 — Organizational memory and evidence provenance surface.
 *
 * The Command Centre memory page retrieves prior cases, tasks and customer history
 * scoped to the company and shows provenance (source entity type and id) for each
 * item.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/command/memory/page.tsx";
const HOME = "src/app/app/command/page.tsx";

describe("MEM-001 — Organizational memory surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const home = readFileSync(HOME, "utf8");

  it("has a real runtime entrypoint under /app/command/memory", () => {
    expect(page).toContain('export const metadata = { title: "Memory — Singha Central"');
    expect(page).toContain("export default async function MemoryPage");
    expect(page).toContain("requireAdmin()");
  });

  it("reads prior cases, tasks, customers and channel identities scoped by company_id", () => {
    expect(page).toContain('from("management_cases")');
    expect(page).toContain('from("tasks")');
    expect(page).toContain('from("customers")');
    expect(page).toContain('from("channel_identities")');
    expect(page).toContain('.eq("company_id", admin.companyId)');
  });

  it("shows provenance for each memory item", () => {
    expect(page).toContain("case:");
    expect(page).toContain("task:");
    expect(page).toContain("customer:");
  });

  it("is linked from the Command Centre", () => {
    expect(home).toContain('href="/app/command/memory"');
    expect(home).toContain("Memory");
  });
});
