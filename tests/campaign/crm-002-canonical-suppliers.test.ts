/**
 * CRM-002 — Canonical supplier identity.
 *
 * The procurement suppliers page must show canonical supplier records, attach channel
 * identities, detect duplicate identities, and surface bank details with a note that
 * changes require approved workflow (migration 0045 maker-checker).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/procurement/suppliers/page.tsx";

describe("CRM-002 — canonical supplier identity surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("reads canonical suppliers instead of a placeholder", () => {
    expect(page).toContain('from("suppliers")');
    expect(page).toMatch(/Canonical suppliers/);
  });

  it("loads channel identities for the suppliers", () => {
    expect(page).toContain('from("channel_identities")');
    expect(page).toContain('actor_type", "supplier"');
    expect(page).toContain("channel_identities");
  });

  it("detects duplicate identities across active suppliers", () => {
    expect(page).toContain("findDuplicateIdentities");
    expect(page).toContain("duplicateSupplierIds");
    expect(page).toMatch(/badge warn.*duplicate/);
  });

  it("does not silently merge duplicates", () => {
    expect(page).not.toContain("mergeSuppliers");
    expect(page).not.toContain(".merge(");
    expect(page).toMatch(/Review and merge them manually/);
  });

  it("shows bank details and flags the maker-checker change control", () => {
    expect(page).toContain("bank_account_number");
    expect(page).toContain("bank_account_name");
    expect(page).toMatch(/changes require approval/);
  });
});
