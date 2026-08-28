/**
 * PACKAGE H — security and tenant isolation.
 *
 * Every assertion here is RULE-BASED. No model judges whether a result is acceptable:
 * a row either crosses a company boundary or it does not, and a request either
 * fail-closes or it does not.
 *
 * Runs against the live campaign stack with REAL GoTrue tokens and REAL RLS.
 */
import { describe, it, expect, beforeAll } from "vitest";
import {
  stackConfigured,
  signInAs,
  serviceClient,
  rest,
  appGet,
  TENANT_A,
  TENANT_B,
  ANON,
} from "./helpers/stack";

describe.skipIf(!stackConfigured)("H — security and tenant isolation", () => {
  let a: Awaited<ReturnType<typeof signInAs>>;
  let b: Awaited<ReturnType<typeof signInAs>>;

  beforeAll(async () => {
    a = await signInAs(TENANT_A.owner);
    b = await signInAs(TENANT_B.owner);
  });

  /* ── H1. The fixtures are real ───────────────────────────────────────── */

  it("H1 — tenant B's own owner CAN read tenant B's records (the control)", async () => {
    // Without this, every isolation assertion below could pass because the row
    // simply does not exist, or because reads are broken for everyone.
    const { status, body } = await rest(
      `/customers?id=eq.${TENANT_B.secretCustomer}&select=id,name,company_id`,
      b.accessToken,
    );
    expect(status).toBe(200);
    const rows = Array.isArray(body) ? (body as { company_id: string }[]) : [];
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(TENANT_B.company);
  });

  /* ── H2. Cross-company reads by direct record id ─────────────────────── */

  it("H2 — tenant A cannot read tenant B's customer by id", async () => {
    const { status, body } = await rest(
      `/customers?id=eq.${TENANT_B.secretCustomer}&select=id,name`,
      a.accessToken,
    );
    expect([200, 401, 403, 404]).toContain(status);
    expect(Array.isArray(body) ? body : []).toHaveLength(0);
  });

  it("H2 — tenant A cannot read tenant B's project or task by id", async () => {
    const targets: [string, string][] = [
      ["projects", TENANT_B.secretProject],
      ["tasks", TENANT_B.secretTask],
    ];
    for (const [table, id] of targets) {
      const { body } = await rest(`/${table}?id=eq.${id}&select=id`, a.accessToken);
      expect(Array.isArray(body) ? body : [], `${table} leaked across tenants`).toHaveLength(0);
    }
  });

  it("H2 — an unfiltered list never returns another company's rows", async () => {
    // The dangerous shape is a broad SELECT with no company filter: if RLS is the only
    // thing standing between tenants, this is where it shows.
    for (const table of ["customers", "projects", "tasks", "memberships", "profiles"]) {
      const { body } = await rest(`/${table}?select=company_id&limit=500`, a.accessToken);
      const rows = Array.isArray(body) ? (body as { company_id: string }[]) : [];
      const foreign = rows.filter((r) => r.company_id && r.company_id !== TENANT_A.company);
      expect(foreign, `${table} returned ${foreign.length} foreign-company rows`).toHaveLength(0);
    }
  });

  /* ── H3. Cross-company WRITES ────────────────────────────────────────── */

  it("H3 — tenant A cannot insert a row into tenant B's company", async () => {
    const marker = "HST cross-tenant insert";
    const { status } = await rest(`/customers`, a.accessToken, {
      method: "POST",
      body: JSON.stringify({ company_id: TENANT_B.company, name: marker, status: "active" }),
    });
    expect(status).toBeGreaterThanOrEqual(400);

    const svc = serviceClient();
    const { data } = await svc.from("customers").select("id").eq("name", marker);
    expect(data ?? [], "a cross-tenant insert was persisted").toHaveLength(0);
  });

  it("H3 — tenant A cannot update or delete tenant B's task", async () => {
    await rest(`/tasks?id=eq.${TENANT_B.secretTask}`, a.accessToken, {
      method: "PATCH",
      body: JSON.stringify({ title: "HST tampered" }),
    });
    await rest(`/tasks?id=eq.${TENANT_B.secretTask}`, a.accessToken, { method: "DELETE" });

    const svc = serviceClient();
    const { data } = await svc.from("tasks").select("id,title").eq("id", TENANT_B.secretTask);
    const rows = (data ?? []) as { title: string }[];
    expect(rows, "tenant B's task was deleted by tenant A").toHaveLength(1);
    expect(rows[0].title).not.toBe("HST tampered");
  });

  /* ── H4. Tampered, forged and expired sessions ───────────────────────── */

  it("H4 — a token with a flipped signature is refused", async () => {
    const [h, p, s] = a.accessToken.split(".");
    const flipped = `${h}.${p}.${s.slice(0, -3)}${s.slice(-3) === "AAA" ? "BBB" : "AAA"}`;
    const { status } = await rest(`/customers?select=id&limit=1`, flipped);
    expect(status).toBe(401);
  });

  it("H4 — a token whose payload was edited to claim service_role is refused", async () => {
    // Re-encoding the payload without the signing key is the realistic attack.
    const [h, p, s] = a.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.role = "service_role";
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    const { status } = await rest(`/customers?select=id&limit=1`, forged);
    expect(status).toBe(401);
  });

  it("H4 — an expired token is refused", async () => {
    const [h, p, s] = a.accessToken.split(".");
    const claims = JSON.parse(Buffer.from(p, "base64url").toString());
    claims.exp = Math.floor(Date.now() / 1000) - 3600;
    const expired = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}`;
    const { status } = await rest(`/customers?select=id&limit=1`, expired);
    expect(status).toBe(401);
  });

  it("H4 — the anon key alone cannot read business data", async () => {
    const { body } = await rest(`/customers?select=id&limit=5`, ANON);
    expect(Array.isArray(body) ? body : []).toHaveLength(0);
  });

  /* ── H5. The application boundary fail-closes ────────────────────────── */

  it("H5 — every /app route redirects an anonymous caller to /login", async () => {
    const routes = [
      "/app",
      "/app/admin",
      "/app/finance",
      "/app/operations",
      "/app/sales",
      "/app/hr",
      "/app/fleet",
      "/app/legal",
      "/app/ai",
      "/app/documents",
      "/app/calendar",
      "/app/admin/audit",
      "/app/admin/employees",
    ];
    for (const r of routes) {
      const res = await appGet(r);
      expect([302, 303, 307, 308], `${r} did not redirect (got ${res.status})`).toContain(res.status);
      expect(res.headers.get("location") ?? "", `${r} redirected somewhere other than /login`).toContain("/login");
    }
  });

  it("H5 — a cron route refuses a caller without the shared secret", async () => {
    for (const r of ["/api/cron/dispatch-drain", "/api/cron/follow-ups", "/api/cron/daily-digest"]) {
      const res = await appGet(r);
      expect([401, 403, 404], `${r} answered ${res.status} without a secret`).toContain(res.status);
    }
  });

  /* ── H6. Hostile input ───────────────────────────────────────────────── */

  it("H6 — oversized input is rejected, or bounded — never stored unbounded", async () => {
    const huge = "A".repeat(2_000_000);
    const { status } = await rest(`/customers`, a.accessToken, {
      method: "POST",
      body: JSON.stringify({ company_id: TENANT_A.company, name: huge, status: "active" }),
    });
    const svc = serviceClient();
    const { data } = await svc
      .from("customers")
      .select("id,name")
      .eq("company_id", TENANT_A.company)
      .like("name", "AAAAAAAAAA%");
    const rows = (data ?? []) as { id: string; name: string }[];
    if (status < 400) {
      for (const row of rows) {
        expect(row.name.length, "an unbounded value landed in a business record").toBeLessThan(10_000);
      }
    } else {
      expect(rows).toHaveLength(0);
    }
    for (const row of rows) await svc.from("customers").delete().eq("id", row.id);
  });

  it("H6 — hostile Unicode round-trips as data and is never interpreted", async () => {
    const hostile =
      "‮gnirts desrever‬ ﻿ <script>alert(1)</script> ' OR 1=1 --";
    const svc = serviceClient();
    const { data, error } = await svc
      .from("customers")
      .insert({ company_id: TENANT_A.company, name: hostile, status: "active" })
      .select("id,name")
      .single();
    expect(error).toBeNull();

    const row = data as { id: string; name: string };
    // The point is that it round-trips as DATA. A SQL-injection payload that changed the
    // query would have failed the insert or altered another tenant's rows.
    expect(row.name).toContain("OR 1=1");
    expect(row.name).toContain("<script>");

    const { data: bTasks } = await svc.from("tasks").select("id").eq("company_id", TENANT_B.company);
    expect((bTasks ?? []).length, "the injection payload reached another tenant").toBe(1);

    await svc.from("customers").delete().eq("id", row.id);
  });
});
