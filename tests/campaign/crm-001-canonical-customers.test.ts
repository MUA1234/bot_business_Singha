/**
 * CRM-001 — Canonical customer identity.
 *
 * The sales customers page must show canonical customer records, attach channel identities
 * from migration 0070, and surface duplicate identities so a person can act on them. It must
 * not silently merge records or hide the conversation view that already exists.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/sales/customers/page.tsx";

describe("CRM-001 — canonical customer identity surface", () => {
  const page = readFileSync(PAGE, "utf8");

  it("reads canonical customers instead of only WhatsApp conversations", () => {
    expect(page).toContain('from("customers")');
    expect(page).toMatch(/Canonical customers/);
  });

  it("loads channel identities for the customers", () => {
    expect(page).toContain('from("channel_identities")');
    expect(page).toContain('actor_type", "customer"');
    expect(page).toContain("channel_identities");
  });

  it("detects duplicate identities across active customers", () => {
    expect(page).toContain("findDuplicateIdentities");
    expect(page).toContain("duplicateCustomerIds");
    expect(page).toMatch(/badge warn.*duplicate/);
  });

  it("does not silently merge duplicates", () => {
    expect(page).not.toContain("mergeCustomers");
    expect(page).not.toContain(".merge(");
    expect(page).toMatch(/Review and merge them manually/);
  });

  it("preserves the existing conversation view and chat links", () => {
    expect(page).toContain('from("wa_conversations")');
    expect(page).toMatch(/Recent WhatsApp conversations/);
    expect(page).toContain('href={`/app/sales/customers/${c.id}`}');
  });
});
