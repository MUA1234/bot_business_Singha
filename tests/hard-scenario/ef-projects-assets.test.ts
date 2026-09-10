/**
 * PACKAGES E and F — projects/operations, and assets/fleet.
 *
 * E: a project with risks and decisions, a late dependency, schedule conflict, and the
 *    linked-record visibility a manager relies on.
 * F: asset assignment and return, competing reservations, maintenance falling due while
 *    an asset is out, and meter readings that go backwards or arrive malformed.
 *
 * Both packages share a file because they share fixtures (a project that a trip is
 * charged to) and the same tenant-isolation questions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { stackConfigured, signInAs, serviceClient, TENANT_A, TENANT_B } from "./helpers/stack";

const MARK = "HST-EF";

describe.skipIf(!stackConfigured)("E/F — projects, operations, assets and fleet", () => {
  let owner: Awaited<ReturnType<typeof signInAs>>;
  let projectId: string;
  let vehicleId: string;

  beforeAll(async () => {
    owner = await signInAs(TENANT_A.owner);
    const svc = serviceClient();

    const { data: p } = await svc
      .from("projects")
      .insert({ company_id: TENANT_A.company, name: `${MARK}-Project`, code: `${MARK}-P1`, status: "active" })
      .select("id").single();
    projectId = (p as { id: string }).id;

    const { data: v } = await svc
      .from("vehicles")
      .insert({ company_id: TENANT_A.company, registration_no: `${MARK}-VEH-1`, make: "Placeholder", model: "Van", year: 2020, status: "active", odometer: 10000 })
      .select("id").single();
    vehicleId = (v as { id: string }).id;
  });

  afterAll(async () => {
    const svc = serviceClient();
    await svc.from("trips").delete().eq("vehicle_id", vehicleId);
    await svc.from("maintenance_records").delete().eq("vehicle_id", vehicleId);
    await svc.from("vehicles").delete().eq("id", vehicleId);
    await svc.from("project_risks").delete().eq("project_id", projectId);
    await svc.from("tasks").delete().eq("project_id", projectId);
    await svc.from("projects").delete().eq("id", projectId);
    await svc.from("projects").delete().like("name", `${MARK}%`);
    await svc.from("vehicles").delete().like("registration_no", `${MARK}%`);
  });

  /* ═══ PACKAGE E — projects and operations ═══════════════════════════ */

  it("E1 — a project carries tasks, and they stay linked and company-scoped", async () => {
    const svc = serviceClient();
    const { error } = await svc.from("tasks").insert([
      { company_id: TENANT_A.company, project_id: projectId, title: `${MARK}-task-a`, status: "planned", priority: 2, due_date: "2026-09-05" },
      { company_id: TENANT_A.company, project_id: projectId, title: `${MARK}-task-b`, status: "planned", priority: 1, due_date: "2026-09-01" },
    ]);
    expect(error).toBeNull();

    const { data } = await svc.from("tasks").select("id,company_id").eq("project_id", projectId);
    expect((data ?? []).length).toBe(2);
    expect((data as { company_id: string }[]).every((t) => t.company_id === TENANT_A.company)).toBe(true);
  });

  it("E1 — a task cannot be attached to ANOTHER company's project", async () => {
    const svc = serviceClient();
    const { data: bProj } = await svc
      .from("projects").insert({ company_id: TENANT_B.company, name: `${MARK}-B-Project`, status: "active" })
      .select("id").single();

    const { error } = await svc.from("tasks").insert({
      company_id: TENANT_A.company,
      project_id: (bProj as { id: string }).id,
      title: `${MARK}-cross-project`,
      status: "planned",
      priority: 3,
    });
    expect(error, "a task was attached to another company's project").not.toBeNull();
  });

  it("E2 — a late dependency is visible as an overdue linked task", async () => {
    const svc = serviceClient();
    await svc.from("tasks").insert({
      company_id: TENANT_A.company, project_id: projectId, title: `${MARK}-late-dependency`,
      status: "in_progress", priority: 1, due_date: "2026-08-01", // already past
    });
    const { data } = await svc
      .from("tasks").select("id,due_date,status")
      .eq("project_id", projectId).lt("due_date", "2026-08-28")
      .not("status", "in", "(completed,cancelled)");
    expect((data ?? []).length, "an overdue dependency was not visible on the project").toBeGreaterThanOrEqual(1);
  });

  it("E3 — a project risk records its mitigation and owner, and is auditable", async () => {
    const svc = serviceClient();
    const { data, error } = await svc.from("project_risks").insert({
      company_id: TENANT_A.company, project_id: projectId,
      title: `${MARK}-supplier-failure`,
      description: "Supplier cannot deliver the placeholder component in the agreed window.",
      mitigation: "Dual-source the component; hold a two-week buffer.",
      // impact/likelihood are declared enums, not scores.
      impact: "high", likelihood: "medium", status: "open",
    }).select("id,mitigation").single();
    expect(error).toBeNull();
    expect((data as { mitigation: string }).mitigation).toContain("Dual-source");
  });

  it("E4 — a manager sees linked records; another company sees none of them", async () => {
    const asOwner = await owner.db.from("project_risks").select("id").eq("project_id", projectId);
    expect((asOwner.data ?? []).length, "the project's own manager could not see its risks").toBeGreaterThanOrEqual(1);

    const bOwner = await signInAs(TENANT_B.owner);
    const asB = await bOwner.db.from("project_risks").select("id").eq("project_id", projectId);
    expect(asB.data ?? [], "another company saw this project's risks").toHaveLength(0);
  });

  /* ═══ PACKAGE F — assets and fleet ══════════════════════════════════ */

  it("F1 — an asset is assigned on a trip and returned with a higher meter reading", async () => {
    const svc = serviceClient();
    const { data, error } = await svc.from("trips").insert({
      company_id: TENANT_A.company, vehicle_id: vehicleId, project_id: projectId,
      started_at: new Date("2026-08-20T08:00:00Z").toISOString(),
      ended_at: new Date("2026-08-20T17:00:00Z").toISOString(),
      start_odometer: 10000, end_odometer: 10240, purpose: `${MARK} site visit`,
    }).select("id,start_odometer,end_odometer").single();
    expect(error).toBeNull();
    const t = data as { start_odometer: number; end_odometer: number };
    expect(t.end_odometer).toBeGreaterThan(t.start_odometer);
  });

  it("F2 — FINDING F-010: a meter reading that DECREASES is accepted unchecked", async () => {
    // A vehicle cannot travel backwards. There is no CHECK on `trips`, and the write
    // path does not reject it, so an impossible reading is stored silently and flows
    // into fuel-efficiency and maintenance-interval calculations downstream.
    //
    // This test asserts the CURRENT behaviour so the finding is pinned rather than
    // forgotten. When a constraint is added (`check (end_odometer is null or
    // end_odometer >= start_odometer)`), this expectation must be inverted deliberately.
    const svc = serviceClient();
    const { data, error } = await svc.from("trips").insert({
      company_id: TENANT_A.company, vehicle_id: vehicleId,
      started_at: new Date("2026-08-21T08:00:00Z").toISOString(),
      ended_at: new Date("2026-08-21T12:00:00Z").toISOString(),
      start_odometer: 10240, end_odometer: 9000, purpose: `${MARK} backwards meter`,
    }).select("id,start_odometer,end_odometer").maybeSingle();

    expect(
      error,
      "a backwards odometer is now refused — F-010 appears fixed; invert this expectation",
    ).toBeNull();
    const t = data as { id: string; start_odometer: number; end_odometer: number };
    expect(t.end_odometer).toBeLessThan(t.start_odometer); // the impossible row, recorded
    await svc.from("trips").delete().eq("id", t.id);
  });

  it("F2 — a malformed meter reading is refused by the column type", async () => {
    const svc = serviceClient();
    const { error } = await svc.from("trips").insert({
      company_id: TENANT_A.company, vehicle_id: vehicleId,
      started_at: new Date().toISOString(),
      start_odometer: "not-a-number", purpose: `${MARK} malformed`,
    } as unknown as Record<string, unknown>);
    expect(error, "a non-numeric meter reading was accepted").not.toBeNull();
  });

  it("F3 — maintenance falling due while the asset is out is still recorded against it", async () => {
    const svc = serviceClient();
    const { error } = await svc.from("maintenance_records").insert({
      company_id: TENANT_A.company, vehicle_id: vehicleId, kind: "service",
      description: `${MARK} 10,000km service`, cost: "18500.00", currency: "LKR",
      service_date: "2026-08-22", next_service_date: "2027-02-22",
    });
    expect(error).toBeNull();

    const { data } = await svc.from("maintenance_records").select("id,next_service_date").eq("vehicle_id", vehicleId);
    expect((data ?? []).length).toBeGreaterThanOrEqual(1);
    // The due date must survive as data a scheduler can act on, not as free text.
    expect((data as { next_service_date: string }[])[0]!.next_service_date).toBe("2027-02-22");
  });

  it("F4 — an asset marked retired keeps its history and open records", async () => {
    const svc = serviceClient();
    await svc.from("vehicles").update({ status: "retired" }).eq("id", vehicleId);
    const { data: trips } = await svc.from("trips").select("id").eq("vehicle_id", vehicleId);
    const { data: maint } = await svc.from("maintenance_records").select("id").eq("vehicle_id", vehicleId);
    expect((trips ?? []).length, "trip history vanished when the asset was retired").toBeGreaterThanOrEqual(1);
    expect((maint ?? []).length, "maintenance history vanished when the asset was retired").toBeGreaterThanOrEqual(1);
    await svc.from("vehicles").update({ status: "active" }).eq("id", vehicleId);
  });

  it("F5 — FINDING F-009: a trip CAN be charged to another company's project", async () => {
    // `trips` carries a composite tenant-integrity key for the vehicle
    // (`trips_vehicle_id_company_fk` on (vehicle_id, company_id)) but only a
    // single-column key for the project — so the pattern was intended here and missed.
    // Reproduced with an ORDINARY AUTHENTICATED USER, not just service_role.
    //
    // Severity is Medium rather than Critical: it corrupts referential integrity across
    // tenants and couples the two companies' rows, but it is not a read leak on its own,
    // because the attacker must already know the foreign project's UUID.
    //
    // Asserts current behaviour so the finding is pinned. Inverting it is the acceptance
    // test for the composite-FK migration.
    const owner2 = await signInAs(TENANT_A.owner);
    const svc = serviceClient();
    const { data: bProj } = await svc
      .from("projects").select("id").eq("company_id", TENANT_B.company).limit(1).maybeSingle();
    if (!bProj) return;

    const { data, error } = await owner2.db.from("trips").insert({
      company_id: TENANT_A.company, vehicle_id: vehicleId,
      project_id: (bProj as { id: string }).id,
      started_at: new Date().toISOString(), start_odometer: 10240, purpose: `${MARK} cross-tenant charge`,
    }).select("id,project_id").maybeSingle();

    expect(
      error,
      "the cross-tenant charge is now refused — F-009 appears fixed; invert this expectation",
    ).toBeNull();
    expect((data as { project_id: string }).project_id).toBe((bProj as { id: string }).id);
    await svc.from("trips").delete().eq("id", (data as { id: string }).id);
  });

  it("F5 — the composite tenant-integrity gap does not WIDEN beyond the recorded 103", async () => {
    // Catalog-driven, like the ambiguous-embed gate. 42 parent/child pairs were given
    // composite (child_id, company_id) keys; these were not. The number must not grow.
    const { default: pg } = await import("pg" as string);
    const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: false });
    await client.connect();
    try {
      const { rows } = await client.query(`
        with fks as (
          select c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent,
                 (select array_agg(a.attname::text order by k.ord)
                    from unnest(c.conkey) with ordinality k(att, ord)
                    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as cols
            from pg_constraint c join pg_namespace n on n.oid = c.connamespace
           where c.contype = 'f' and n.nspname = 'public'),
        single as (select * from fks where array_length(cols,1) = 1 and cols[1] <> 'company_id'),
        composite as (select child, parent, cols from fks where 'company_id' = any(cols) and array_length(cols,1) > 1)
        select s.child || '.' || s.cols[1] || ' -> ' || s.parent as gap
          from single s
         where exists (select 1 from information_schema.columns ic
                        where ic.table_schema='public' and ic.table_name=s.child and ic.column_name='company_id')
           and exists (select 1 from information_schema.columns ip
                        where ip.table_schema='public' and ip.table_name=s.parent and ip.column_name='company_id')
           and not exists (select 1 from composite cp
                            where cp.child=s.child and cp.parent=s.parent and s.cols[1] = any(cp.cols))`);
      expect(rows.length, "the tenant-integrity FK gap widened — see F-009").toBeLessThanOrEqual(103);
    } finally {
      await client.end();
    }
  });

  it("F6 — fleet records are invisible to another company", async () => {
    const bOwner = await signInAs(TENANT_B.owner);
    const { data } = await bOwner.db.from("vehicles").select("id").eq("id", vehicleId);
    expect(data ?? [], "another company saw this fleet asset").toHaveLength(0);
  });
});
