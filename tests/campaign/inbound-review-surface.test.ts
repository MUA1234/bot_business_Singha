/**
 * FOUND-003 — the review queue must be a place a person can actually reach and use.
 *
 * A durable row nobody can open is the same defect one level up from a log line nobody reads. These
 * are narrow, targeted assertions about the surface: it is in the navigation, it is capability-
 * gated rather than department-gated, it never renders a confident empty state when the query
 * failed, and the message text is presented as data.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { unattributedInboundLevel } from "@/lib/health-signals";

const PAGE = "src/app/app/admin/inbound-review/page.tsx";
const ROW = "src/app/app/admin/inbound-review/ReviewRow.tsx";
const ACTIONS = "src/app/app/admin/inbound-review/actions.ts";

describe("FOUND-003 — the review queue is reachable and honest", () => {
  it("it is in the navigation, not an unlinked URL", () => {
    const nav = readFileSync("src/lib/departments.ts", "utf8");
    expect(nav).toContain("/app/admin/inbound-review");
  });

  it("access is decided by CAPABILITY, not by department or an admin flag", () => {
    const page = readFileSync(PAGE, "utf8");
    expect(page).toContain("membershipHasCapability");
    expect(page).toContain("INBOUND_REVIEW_CAPABILITY");
    expect(page).not.toMatch(/isAdmin|department ===/);
  });

  it("a failed query says so instead of rendering an empty queue", () => {
    const page = readFileSync(PAGE, "utf8");
    expect(page).toContain("unavailable");
    expect(page).toMatch(/cannot be shown|not present in this database/);
    // The "nothing waiting" message is only reachable when the read actually succeeded.
    expect(page).toMatch(/!unavailable && open\.length === 0/);
  });

  it("the capability constant is shared, so the page and the action cannot disagree", () => {
    const cap = readFileSync("src/app/app/admin/inbound-review/capability.ts", "utf8");
    expect(cap).toContain("operations.inbound.review");
    for (const f of [PAGE, ACTIONS]) expect(readFileSync(f, "utf8")).toContain('from "./capability"');
  });

  it("closing a review goes through the audited RPC, not a bare table update", () => {
    const actions = readFileSync(ACTIONS, "utf8");
    expect(actions).toContain("resolve_inbound_review");
    expect(actions).toContain("requireCapability");
    expect(actions).not.toMatch(/\.from\("inbound_reviews"\)\s*\.update/);
  });

  it("a decision someone else already made is reported, not silently overwritten", () => {
    const actions = readFileSync(ACTIONS, "utf8");
    expect(actions).toMatch(/Already \$\{finalState\}|already/i);
  });

  it("the message text is rendered as quoted data", () => {
    const row = readFileSync(ROW, "utf8");
    expect(row).toContain("blockquote");
    expect(row).toMatch(/body_excerpt/);
  });
});

describe("FOUND-003 — inbound that belongs to NO company is visible in health", () => {
  it("any unattributed event is at least a warning", () => {
    expect(unattributedInboundLevel(0)).toBe("ok");
    expect(unattributedInboundLevel(1)).toBe("warn");
    expect(unattributedInboundLevel(21)).toBe("crit");
  });

  it("an unavailable count is never reported as all clear", () => {
    expect(unattributedInboundLevel(null)).toBe("warn");
  });

  it("the health endpoint actually reports it", () => {
    const route = readFileSync("src/app/api/health/route.ts", "utf8");
    expect(route).toContain("unattributedInbound");
    expect(route).toContain("openInboundReviews");
    expect(route).toContain("unattributedInboundLevel(");
  });
});

describe("R1 §5 — owner configuration has a surface, and it says what is missing", () => {
  const SETUP = "src/app/app/admin/inbound-setup/page.tsx";
  const ACTIONS = "src/app/app/admin/inbound-setup/actions.ts";

  it("the setup screen is in the navigation", () => {
    expect(readFileSync("src/lib/departments.ts", "utf8")).toContain("/app/admin/inbound-setup");
  });

  it("it says CONFIGURATION REQUIRED until a number is mapped", () => {
    const page = readFileSync(SETUP, "utf8");
    expect(page).toContain("Configuration required");
    expect(page).toMatch(/activeWhatsapp === 0/);
  });

  it("it discloses when the single-tenant bridge is what is attributing messages", () => {
    expect(readFileSync(SETUP, "utf8")).toMatch(/single_tenant_bridge_in_use|single-tenant bridge/);
  });

  it("it surfaces an ambiguous mapping rather than resolving it silently", () => {
    const page = readFileSync(SETUP, "utf8");
    expect(page).toContain("conflicting_accounts");
    expect(page).toMatch(/will not take it over/);
  });

  it("every change goes through the audited RPCs, never a bare table write", () => {
    const actions = readFileSync(ACTIONS, "utf8");
    for (const rpc of ["admin_upsert_channel_account", "admin_set_channel_account_active", "admin_set_membership_role"]) {
      expect(actions).toContain(rpc);
    }
    expect(actions).not.toMatch(/\.from\("channel_accounts"\)\s*\.(insert|update|delete)/);
    expect(actions).not.toMatch(/\.from\("membership_roles"\)\s*\.(insert|delete)/);
  });

  it("both capabilities are required in the app as well as at the database", () => {
    const actions = readFileSync(ACTIONS, "utf8");
    expect(actions).toContain('requireCapability("admin.organisation.manage")');
    expect(actions).toContain('requireCapability("admin.identity.manage")');
  });
});
