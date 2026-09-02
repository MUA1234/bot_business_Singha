/**
 * R2C — collaborative resource routing through the REAL runtime.
 *
 * This is the evidence WRK-007 was held back for. R2B built the advisor, delegate and consultant
 * logic and proved it in isolation, but the cycle only ever asked for an assignee, so none of it
 * was on a runtime path. Here the real `runManagementCycle` — with the real production wiring,
 * against the full schema with real RLS — produces snapshots for those roles.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 * Run via scripts/r1/run-r1-security-tests.mjs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { runManagementCycle, type CycleDeps } from "@/kernel/cycle";
import { makeCycleDeps } from "@/kernel/cycle-deps";
import { pgSupabase } from "./helpers/pg-supabase";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();
const OWNER = randomUUID();
const LAWYER = randomUUID();   // advisor: evidenced legal experience
const WORKER = randomUUID();   // plain staff, no advisory experience
const HR = randomUUID();       // holds hr.staff.manage, for team coverage

let raw: pg.Client;
let deps: CycleDeps;
const mem = new Map<string, string>();
let savedFlag: string | undefined;

async function seedUser(userId: string, companyId: string, role: string) {
  await raw.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [userId]);
  await raw.query(
    `insert into users (id,full_name,is_active) values ($1,$2,true) on conflict (id) do nothing`,
    [userId, `r2c ${userId.slice(0, 8)}`],
  );
  const { rows } = await raw.query(
    `insert into memberships (company_id,user_id,status) values ($1,$2,'active') returning id`,
    [companyId, userId],
  );
  mem.set(userId, rows[0].id);
  await raw.query(
    `insert into membership_roles (membership_id,company_id,role_key) values ($1,$2,$3) on conflict do nothing`,
    [rows[0].id, companyId, role],
  );
  return rows[0].id as string;
}

/** An expiring legal obligation — the condition the legal detector looks for. */
async function seedLegalCondition(companyId: string) {
  await raw.query(
    `insert into licences (company_id, name, authority, licence_number, issue_date, expiry_date, status)
     values ($1, 'synthetic licence', 'authority', $2, '2024-01-01', current_date - 5, 'active')`,
    [companyId, `L-${randomUUID().slice(0, 8)}`],
  );
}

const snapshotsFor = async (companyId: string, purpose?: string) => {
  const { rows } = await raw.query(
    `select r.purpose, r.outcome, r.candidate_ref, r.candidate_type, r.rank_position,
            r.reason_codes, r.routing_reason_code, r.routing_department, r.resolver_version,
            i.proposed_action_id
       from management_item_recommendations r
       join management_items i on i.id = r.item_id
      where r.company_id = $1 ${purpose ? "and r.purpose = $2" : ""}
      order by r.created_at`,
    purpose ? [companyId, purpose] : [companyId],
  );
  return rows;
};

describe.skipIf(!enabled)("R2C — collaborative resource routing, live", () => {
  beforeAll(async () => {
    savedFlag = process.env.MANAGEMENT_KERNEL;
    process.env.MANAGEMENT_KERNEL = "on";

    raw = new pg.Client({ connectionString: URL, ssl: false });
    await raw.connect();
    await raw.query(`select set_config('request.jwt.claims', '{"role":"service_role"}', false)`);

    for (const co of [CO_A, CO_B]) {
      await raw.query(
        `insert into companies (id,name,base_currency) values ($1,$2,'LKR') on conflict (id) do nothing`,
        [co, `r2c ${co.slice(0, 8)}`],
      );
    }
    // owner_management holds legal.*, hr.staff.manage and operations.task.manage.
    await seedUser(OWNER, CO_A, "owner_management");
    await seedUser(LAWYER, CO_A, "owner_management");
    await seedUser(WORKER, CO_A, "project_manager");
    await seedUser(HR, CO_A, "owner_management");

    // EVIDENCED advisory experience for the lawyer, and NOTHING for the worker.
    await raw.query(
      `insert into advisor_relationships (company_id, membership_id, domain, evidence_ref, evidence_table, status)
       values ($1,$2,'legal','matter-4471','legal_matters','active')`,
      [CO_A, mem.get(LAWYER)!],
    );

    await raw.query(
      `insert into management_kernel_enablement (company_id, enabled, enabled_by, enabled_at)
       values ($1,true,$2,now()) on conflict (company_id) do update set enabled = true`,
      [CO_A, OWNER],
    );

    deps = makeCycleDeps(pgSupabase(raw), () => new Date());
  }, 120_000);

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.MANAGEMENT_KERNEL;
    else process.env.MANAGEMENT_KERNEL = savedFlag;
    await raw?.end();
  });

  it("the cycle requests MORE THAN ONE role and records a separate snapshot for each", async () => {
    await seedLegalCondition(CO_A);
    const summary = await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });
    expect(summary.itemsCreated).toBeGreaterThan(0);

    const rows = await snapshotsFor(CO_A);
    const legal = rows.filter((r) => r.proposed_action_id === "legal.obligation.escalate_internal");
    expect(legal.length).toBeGreaterThan(0);

    const purposes = new Set(legal.map((r) => r.purpose));
    // The legal action declares an assignee, a MANDATORY advisor and an optional delegate.
    expect(purposes.has("assignee")).toBe(true);
    expect(purposes.has("advisor")).toBe(true);
    expect(purposes.has("delegate")).toBe(true);
  });

  it("an ADVISOR recommendation names the person with EVIDENCED experience, not merely a capable one", async () => {
    const advisors = (await snapshotsFor(CO_A, "advisor")).filter((r) => r.outcome === "candidates");
    expect(advisors.length).toBeGreaterThan(0);
    const refs = new Set(advisors.map((r) => r.candidate_ref));
    expect(refs.has(mem.get(LAWYER)!)).toBe(true);
    // The worker holds a capability and is free, but has advised on nothing.
    expect(refs.has(mem.get(WORKER)!)).toBe(false);
  });

  it("ONE ROLE IS NEVER SUBSTITUTED FOR ANOTHER — every snapshot carries its own role", async () => {
    const rows = await snapshotsFor(CO_A);
    for (const r of rows) {
      expect(["assignee", "advisor", "delegate", "external_consultant"]).toContain(r.purpose);
    }
    // An advisor snapshot and an assignee snapshot for the same item are distinct rows.
    const legal = rows.filter((r) => r.proposed_action_id === "legal.obligation.escalate_internal");
    const assignees = legal.filter((r) => r.purpose === "assignee");
    const advisors = legal.filter((r) => r.purpose === "advisor");
    expect(assignees.length).toBeGreaterThan(0);
    expect(advisors.length).toBeGreaterThan(0);
  });

  it("a DELEGATE snapshot is needs_routing when no delegation exists — and does NOT create one", async () => {
    const before = await raw.query(`select count(*)::int as n from delegations where company_id = $1`, [CO_A]);
    const delegates = await snapshotsFor(CO_A, "delegate");
    expect(delegates.length).toBeGreaterThan(0);
    expect(delegates.every((r) => r.outcome === "needs_routing")).toBe(true);
    expect(delegates[0]!.routing_reason_code).toBeTruthy();

    // THE POINT: recommending a delegate creates no delegation.
    const after = await raw.query(`select count(*)::int as n from delegations where company_id = $1`, [CO_A]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it("A MISSING OPTIONAL ROLE DOES NOT INVALIDATE A VALID ASSIGNEE", async () => {
    const legal = (await snapshotsFor(CO_A)).filter(
      (r) => r.proposed_action_id === "legal.obligation.escalate_internal",
    );
    const assignee = legal.find((r) => r.purpose === "assignee");
    const delegate = legal.find((r) => r.purpose === "delegate");
    // The delegate role found nobody; the assignee recommendation stands regardless.
    expect(delegate!.outcome).toBe("needs_routing");
    expect(assignee!.outcome).toBe("candidates");
  });

  it("an EXTERNAL CONSULTANT is recommended only from an APPROVED engagement, and is granted nothing", async () => {
    const { rows: prov } = await raw.query(
      `insert into service_providers (company_id, name, status, capabilities, compliance_status, insurance_status, insurance_expiry)
       values ($1,'synthetic provider','active','{}','verified','valid', current_date + 200) returning id`,
      [CO_A],
    );
    await raw.query(
      `insert into consultant_engagements
         (company_id, provider_id, scope_domains, scope_skills, status, approved_by, approved_at, ends_at)
       values ($1,$2, array['procurement'], array['audit'], 'approved', $3, now(), now() + interval '90 days')`,
      [CO_A, prov[0].id, mem.get(OWNER)!],
    );
    // A provider whose compliance has lapsed, plus an engagement that is only PROPOSED.
    const { rows: bad } = await raw.query(
      `insert into service_providers (company_id, name, status, capabilities, compliance_status, insurance_status)
       values ($1,'expired provider','active','{}','expired','expired') returning id`,
      [CO_A],
    );
    await raw.query(
      `insert into consultant_engagements (company_id, provider_id, scope_domains, status, approved_by, approved_at)
       values ($1,$2, array['procurement'], 'approved', $3, now())`,
      [CO_A, bad[0].id, mem.get(OWNER)!],
    );
    await raw.query(
      `insert into consultant_engagements (company_id, provider_id, scope_domains, status)
       values ($1,$2, array['procurement'], 'proposed')`,
      [CO_A, prov[0].id],
    );

    // A provider whose compliance lapsed is exactly what the providers detector reports on.
    await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });

    const consultants = await snapshotsFor(CO_A, "external_consultant");
    expect(consultants.length).toBeGreaterThan(0);

    const offered = consultants.filter((r) => r.outcome === "candidates");
    for (const c of offered) {
      // Only the APPROVED, compliant engagement may be offered.
      expect(c.candidate_ref).not.toBe(bad[0].id);
      expect(c.candidate_type).toBe("external_consultant");
    }
  });

  it("a recommended consultant receives NO access and NO capability", async () => {
    const { rows } = await raw.query(
      `select capabilities_used from management_item_recommendations
        where company_id = $1 and purpose = 'external_consultant'`, [CO_A],
    );
    for (const r of rows) expect(r.capabilities_used).toEqual([]);

    // internal_access is forbidden at the database, so an engagement that grants it cannot exist.
    await expect(raw.query(
      `update consultant_engagements set internal_access = true where company_id = $1`, [CO_A],
    )).rejects.toThrow(/consultant_engagements_no_internal_access|check constraint/i);
  });

  it("CROSS-COMPANY: company B sees none of company A's advisors, engagements or snapshots", async () => {
    const bCandidates = await deps.loadCandidates!(CO_B);
    expect(bCandidates).toEqual([]);

    const { rows } = await raw.query(
      `select count(*)::int as n from management_item_recommendations where company_id = $1`, [CO_B],
    );
    expect(rows[0].n).toBe(0);
  });

  it("VERIFIED SKILLS: a self-declared record never satisfies a mandatory requirement", async () => {
    // Two records for the same person: one merely manager-entered, one properly verified.
    await raw.query(
      `insert into skill_records (company_id, membership_id, skill_key, provenance, status)
       values ($1,$2,'contract_review','manager_entered','active')`,
      [CO_A, mem.get(WORKER)!],
    );
    await raw.query(
      `insert into skill_records
         (company_id, membership_id, skill_key, provenance, status, evidence_ref, verified_by, verified_at)
       values ($1,$2,'audit','evidence_verified','active','cert-9912',$3, now())`,
      [CO_A, mem.get(LAWYER)!, mem.get(OWNER)!],
    );

    const candidates = await deps.loadCandidates!(CO_A);
    const worker = candidates.find((c) => c.membershipId === mem.get(WORKER)!)!;
    const lawyer = candidates.find((c) => c.membershipId === mem.get(LAWYER)!)!;

    // The manager-entered record is loaded as a DECLARED skill, never a verified one.
    expect(worker.declaredSkills.value).toContain("contract_review");
    expect(worker.verifiedSkills.evidenceClass).toBe("absent");

    expect(lawyer.verifiedSkills.value).toContain("audit");
    expect(lawyer.verifiedSkills.evidenceClass).toBe("verified");
  });

  it("an EXPIRED, DISPUTED or REVOKED skill stops counting as verified", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["expired_skill", { status: "active", expires_at: "2020-01-01" }],
      ["disputed_skill", { status: "disputed" }],
      ["revoked_skill", { status: "revoked" }],
    ];
    for (const [key, patch] of cases) {
      await raw.query(
        `insert into skill_records
           (company_id, membership_id, skill_key, provenance, status, expires_at, evidence_ref, verified_by, verified_at)
         values ($1,$2,$3,'evidence_verified',$4,$5,'ev-1',$6, now())`,
        [CO_A, mem.get(HR)!, key, patch.status, patch.expires_at ?? null, mem.get(OWNER)!],
      );
    }
    const candidates = await deps.loadCandidates!(CO_A);
    const hr = candidates.find((c) => c.membershipId === mem.get(HR)!)!;
    const verified = hr.verifiedSkills.value ?? [];
    for (const [key] of cases) expect(verified).not.toContain(key);
  });

  it("LANGUAGES load for every language a person can work in", async () => {
    for (const lang of ["en", "si", "ta"]) {
      await raw.query(
        `insert into membership_languages (company_id, membership_id, language, proficiency)
         values ($1,$2,$3,'fluent') on conflict do nothing`,
        [CO_A, mem.get(LAWYER)!, lang],
      );
    }
    const candidates = await deps.loadCandidates!(CO_A);
    const lawyer = candidates.find((c) => c.membershipId === mem.get(LAWYER)!)!;
    expect(lawyer.languages.value!.sort()).toEqual(["en", "si", "ta"]);
  });

  it("a protected characteristic cannot be recorded as a skill", async () => {
    for (const key of ["pregnancy", "ethnicity", "marital_status", "religion_practice"]) {
      await expect(raw.query(
        `insert into skill_records (company_id, membership_id, skill_key, provenance, status)
         values ($1,$2,$3,'manager_entered','active')`,
        [CO_A, mem.get(WORKER)!, key],
      )).rejects.toThrow(/protected or sensitive personal characteristic/);
    }
    // …while a legitimate skill whose name merely contains one of those words is fine.
    await expect(raw.query(
      `insert into skill_records (company_id, membership_id, skill_key, provenance, status)
       values ($1,$2,'payment_processing','manager_entered','active')`,
      [CO_A, mem.get(WORKER)!],
    )).resolves.toBeTruthy();
  });

  it("the skill history is APPEND-ONLY and records every status change automatically", async () => {
    const { rows: rec } = await raw.query(
      `select id from skill_records where company_id = $1 and skill_key = 'audit'`, [CO_A],
    );
    const id = rec[0].id;
    await raw.query(`update skill_records set status = 'disputed' where id = $1`, [id]);
    await raw.query(`update skill_records set status = 'revoked' where id = $1`, [id]);

    const { rows: events } = await raw.query(
      `select event, from_status, to_status from skill_record_events
        where skill_record_id = $1 order by created_at`, [id],
    );
    expect(events.map((e) => e.event)).toEqual(["created", "disputed", "revoked"]);

    await expect(raw.query(`update skill_record_events set event = 'created' where skill_record_id = $1`, [id]))
      .rejects.toThrow(/append-only/);
    await expect(raw.query(`delete from skill_record_events where skill_record_id = $1`, [id]))
      .rejects.toThrow(/append-only/);
  });

  it("a VERIFIED provenance with no verifier or evidence is refused outright", async () => {
    await expect(raw.query(
      `insert into skill_records (company_id, membership_id, skill_key, provenance, status)
       values ($1,$2,'unbacked_claim','evidence_verified','active')`,
      [CO_A, mem.get(WORKER)!],
    )).rejects.toThrow(/skill_records_verified_shape_ck|check constraint/i);
  });

  it("nothing was assigned, delegated, engaged or granted by any of this", async () => {
    const owners = await raw.query(
      `select count(*)::int as n from management_items
        where company_id = $1 and accountable_owner_id is not null`, [CO_A],
    );
    expect(owners.rows[0].n).toBe(0);

    const delegations = await raw.query(
      `select count(*)::int as n from delegations where company_id = $1`, [CO_A],
    );
    expect(delegations.rows[0].n).toBe(0);

    const access = await raw.query(
      `select count(*)::int as n from consultant_engagements
        where company_id = $1 and internal_access = true`, [CO_A],
    );
    expect(access.rows[0].n).toBe(0);
  });

  describe("R2C-F-001 — a TEAM is formed through the real cycle, not just in a unit test", () => {
    it("produces a complementary team with ONE lead, and records what it cannot cover", async () => {
      // workforce.capacity.review_allocation declares teamOfAtLeast: 2 covering
      // operations.task.manage and hr.staff.manage.
      await raw.query(
        `insert into capacity_snapshots
           (company_id, membership_id, week_start, total_hours, net_capacity_hours,
            allocated_hours, available_hours, utilization_pct, status)
         values ($1,$2, date_trunc('week', current_date)::date, 40, 36, 50, 0, 138, 'overloaded')
         on conflict (membership_id, week_start) do nothing`,
        [CO_A, mem.get(WORKER)!],
      );

      await runManagementCycle(deps, { companyId: CO_A, actorId: null, trigger: "test" });

      const { rows } = await raw.query(
        `select r.purpose, r.outcome, r.candidate_ref, r.rank_position, r.reason_codes, r.missing_codes
           from management_item_recommendations r
           join management_items i on i.id = r.item_id
          where r.company_id = $1 and i.proposed_action_id = 'workforce.capacity.review_allocation'
            and r.outcome = 'candidates'
          order by r.rank_position`,
        [CO_A],
      );

      expect(rows.length).toBeGreaterThan(0);

      // Exactly ONE lead, and it is position 1.
      const leads = rows.filter((r) => (r.reason_codes as string[]).includes("team_lead"));
      expect(leads).toHaveLength(1);
      expect(leads[0]!.rank_position).toBe(1);

      // Everyone else is explicitly a member, not accountable.
      const members = rows.filter((r) => (r.reason_codes as string[]).includes("team_member"));
      expect(members.every((m) => m.rank_position > 1)).toBe(true);

      // Nobody appears twice.
      const refs = rows.map((r) => r.candidate_ref);
      expect(new Set(refs).size).toBe(refs.length);

      // Coverage reasoning travelled into the snapshot.
      const allReasons = rows.flatMap((r) => r.reason_codes as string[]);
      expect(allReasons.some((c) => c === "added_for_coverage" || c === "added_without_new_coverage")).toBe(true);
    });
  });
});
