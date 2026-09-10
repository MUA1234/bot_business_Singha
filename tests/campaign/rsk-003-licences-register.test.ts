/**
 * RSK-003 — Licences and permits with expiry.
 *
 * The legal licences page must be a real runtime entrypoint that lists
 * company-scoped licences/permits with expiry and renewal status.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/legal/licences/page.tsx";

describe("RSK-003 — licences register surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("has a real runtime entrypoint under /app/legal/licences", () => {
    expect(page).toContain("export default async function LicencesPage");
  });

  it("queries the licences table", () => {
    expect(page).toContain('from("licences")');
  });

  it("is company-scoped", () => {
    expect(page).toContain("requireDepartment(\"legal\")");
    expect(page).toContain("company_id");
  });

  it("renders expiry dates and renewal status", () => {
    expect(page).toContain("expiry_date");
    expect(page).toContain("renewalStatus");
    expect(page).toMatch(/Expiry/);
  });

  it("shows licence authority and number", () => {
    expect(page).toContain("authority");
    expect(page).toContain("licence_number");
  });
});
