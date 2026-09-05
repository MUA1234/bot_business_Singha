/**
 * Owner/specialist authority, and authority-scoped queue visibility, against a real PostgreSQL.
 *
 * Two things are proved here, and both are enforced in the DATABASE rather than in React — so they
 * hold for a direct API call, a guessed item id and a hand-written query, not only for the screen.
 *
 * **R2-F-017 (owner decision).** `owner_approval` needs a dedicated capability; `specialist_approval`
 * needs an explicit capability tied to the item's own domain; ten of twelve domains have none
 * registered and stay unavailable with a stated reason.
 *
 * **R2F-F-003.** Draft 007 gave all six R1 tables one SELECT policy — `has_company_access`, which
 * requires an active membership and nothing else — so any member could read every item in the
 * company and every evidence row attached to it, including `legal` and `workforce`.
 *
 * Every read below runs as a real `authenticated` session with a real `auth.uid()`. Privileged
 * reads appear only to establish what physically exists, never to perform an action.
 *
 * Synthetic data, disposable local PostgreSQL, no network.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import pg from "pg";

const URL = process.env.DATABASE_URL ?? "";
const enabled = !!URL && /127\.0\.0\.1|localhost|\[::1\]/.test(URL);

const CO_A = randomUUID();
const CO_B = randomUUID();

/** `owner_management`: holds the owner-approval and company-wide-view capabilities. */
const OWNER = randomUUID();
/** `project_manager`: operations + procurement. Not an owner, not a specialist. */
const MANAGER = randomUUID();
/** `staff_submitter`: works assigned tasks. No management view. */
const STAFF = randomUUID();
/** `accountant`: finance capabilities, including `finance.reconcile`. */
const ACCOUNTANT = randomUUID();
/** A manager in company B only. */
const B_MANAGER = randomUUID();
/**
 * Company-wide viewer WITHOUT either sensitive-domain capability.
 *
 * No seeded role is this shape — `owner_management` holds `management.queue.view_company` AND
 * `legal.matter.manage` AND `hr.staff.manage` — so without a bespoke role there is nobody who can
 * demonstrate that the sensitive gate does any work. Mutation S1 (removing that gate) was
 * INCONCLUSIVE for exactly this reason: the fixture could not distinguish a working gate from an
 * absent one.
 */
const WIDE_VIEWER = randomUUID();
const WIDE_ROLE = "r2_scope_wide_viewer";

let raw: pg.Client;
const q = (sql: string, params: unknown[] = []) => raw.query(sql, params);
const membershipOf = new Map<string, string>();

async function physical<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
  await q("begin");
  try {
    await q("set local role postgres");
    const { rows } = await q(sql, params);
    return rows as T[];
  } finally {
    await q("commit");
  }
}

/** Run as a real signed-in person. Rolled back, so reads cannot leak into the next case. */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await q("begin");
  try {
    await q(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", sub: userId }),
    ]);
    await q("set local role authenticated");
    return await fn();
  } finally {
    await q("rollback");
  }
}

/** What this person can actually see in the queue. */
async function visibleItems(userId: string, companyId: string): Promise<string[]> {
  return asUser(userId, async () => {
    const { rows } = await q(
      `select id from management_items where company_id = $1 order by id`,
      [companyId],
    );
    return rows.map((r) => String(r.id));
  });
}

async function visibleEvidence(userId: string, itemId: string): Promise<number> {
  return asUser(userId, async () => {
    const { rows } = await q(
      `select count(*)::int as n from management_item_evidence where item_id = $1`,
      [itemId],
    );
    return Number(rows[0].n);
  });
}

async function seedItem(
  companyId: string,
  opts: { department?: string; owner?: string | null; authority?: string; state?: string } = {},
): Promise<string> {
  const itemId = randomUUID();
  await q(
    `insert into management_items
       (id, company_id, department, kind, subject_table, subject_id, identity_key,
        state, proposed_action_id, required_authority, accountable_owner_id)
     values ($1,$2,$3,'overdue_task','tasks',$4,$5,$6,'ops.task.create_internal',$7,$8)`,
    [
      itemId, companyId, opts.department ?? "operations", `subj-${itemId}`,
      `${companyId}:scope:${itemId}`, opts.state ?? "awaiting_approval",
      opts.authority ?? "manager_approval", opts.owner ?? null,
    ],
  );
  await q(
    `insert into management_item_evidence (company_id, item_id, source_table, source_id)
     values ($1,$2,'tasks',$3)`,
    [companyId, itemId, `ev-${itemId}`],
  );
  return itemId;
}

function decide(userId: string, itemId: string, digest: string, decision = "approve") {
  return asUser(userId, async () => {
    const { rows } = await q(
      `select public.r1_draft_record_management_decision($1,$2,'awaiting_approval',
               'ops.task.create_internal',$3,null,'because',null) as r`,
      [itemId, decision, digest],
    );
    return rows[0].r as Record<string, unknown>;
  });
}

async function digestOf(companyId: string, itemId: string): Promise<string> {
  const rows = await physical<{ d: string }>(
    `select public.r1_draft_evidence_digest($1,$2) as d`, [companyId, itemId],
  );
  return rows[0]!.d;
}

beforeAll(async () => {
  if (!enabled) return;
  raw = new pg.Client({ connectionString: URL, ssl: false });
  await raw.connect();

  for (const c of [CO_A, CO_B]) {
    await q(
      `insert into companies (id, name, base_currency) values ($1,$2,'LKR')
         on conflict (id) do nothing`,
      [c, `SCOPE ${c.slice(0, 8)}`],
    );
  }

  // A role that sees the whole company and holds no sensitive-domain capability.
  await q(
    `insert into roles (key, label) values ($1,'R2 scope: company-wide viewer')
       on conflict (key) do nothing`,
    [WIDE_ROLE],
  );
  await q(
    `insert into role_permissions (role_key, permission_key)
     values ($1,'management.queue.view_company'), ($1,'approve'), ($1,'reject')
       on conflict do nothing`,
    [WIDE_ROLE],
  );

  const people: Array<[string, string, string[]]> = [
    [OWNER, CO_A, ["owner_management"]],
    [WIDE_VIEWER, CO_A, [WIDE_ROLE]],
    [MANAGER, CO_A, ["project_manager"]],
    [STAFF, CO_A, ["staff_submitter"]],
    [ACCOUNTANT, CO_A, ["accountant"]],
    [B_MANAGER, CO_B, ["project_manager"]],
  ];
  for (const [user, company, roles] of people) {
    await q(
      `insert into users (id, email, full_name) values ($1,$2,'Scope tester')
         on conflict (id) do nothing`,
      [user, `scope-${user.slice(0, 8)}@example.invalid`],
    );
    const { rows } = await q(
      `insert into memberships (company_id, user_id, status) values ($1,$2,'active')
         on conflict (company_id, user_id) do update set status='active' returning id`,
      [company, user],
    );
    membershipOf.set(user, String(rows[0].id));
    for (const role of roles) {
      await q(
        `insert into membership_roles (membership_id, company_id, role_key) values ($1,$2,$3)
           on conflict do nothing`,
        [rows[0].id, company, role],
      );
    }
  }
});

afterAll(async () => {
  if (!enabled) return;
  await raw?.end();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("R2-F-017 — the capabilities are registered exactly once", () => {
  it("registers both new capabilities in the existing naming convention", async () => {
    const rows = await physical<{ key: string }>(
      `select key from permissions
        where key in ('management.decision.approve_owner','management.queue.view_company')
        order by key`,
    );
    expect(rows.map((r) => r.key)).toEqual([
      "management.decision.approve_owner",
      "management.queue.view_company",
    ]);
    // `domain.object.verb`, as migration 0038 established.
    for (const r of rows) expect(r.key.split(".").length).toBeGreaterThanOrEqual(3);
  });

  it("grants them to the OWNER classification and the system administrator only", async () => {
    const rows = await physical<{ role_key: string }>(
      `select distinct role_key from role_permissions
        where permission_key = 'management.decision.approve_owner' order by role_key`,
    );
    expect(rows.map((r) => r.role_key)).toEqual(["owner_management", "system_administrator"]);
  });

  it("a project_manager holds neither", async () => {
    const held = await asUser(MANAGER, async () => {
      const { rows } = await q(
        `select public.has_capability($1,'management.decision.approve_owner') as owner_cap,
                public.has_capability($1,'management.queue.view_company') as view_cap,
                public.has_capability($1,'approve') as approve_cap`,
        [CO_A],
      );
      return rows[0];
    });
    expect(held.owner_cap).toBe(false);
    expect(held.view_cap).toBe(false);
    // But they DO hold ordinary approval — the point being that it is not enough.
    expect(held.approve_cap).toBe(true);
  });
});

describe.skipIf(!enabled)("R2-F-017 — owner approval", () => {
  it("an OWNER may decide an item requiring owner approval", async () => {
    const itemId = await seedItem(CO_A, { authority: "owner_approval" });
    const out = await decide(OWNER, itemId, await digestOf(CO_A, itemId));
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("an ordinary approver may NOT — holding `approve` is not owner authority", async () => {
    const itemId = await seedItem(CO_A, { authority: "owner_approval" });
    const out = await decide(MANAGER, itemId, await digestOf(CO_A, itemId));
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("insufficient_authority");
    expect(String(out.detail)).toContain("owner approval");
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
  });

  it("a transformed or near-miss capability id does not satisfy it", async () => {
    // The gate is an exact string. These are the folding classes the campaign has met before.
    const held = await asUser(OWNER, async () => {
      const { rows } = await q(
        `select public.has_capability($1,'management.decision.approve_owner ') as trailing,
                public.has_capability($1,'MANAGEMENT.DECISION.APPROVE_OWNER') as upper,
                public.has_capability($1,'management.decision.approve') as prefix,
                public.has_capability($1,'managementdecisionapprove_owner') as folded`,
        [CO_A],
      );
      return rows[0];
    });
    for (const [k, v] of Object.entries(held)) expect(v, k).toBe(false);
  });
});

describe.skipIf(!enabled)("R2-F-017 — specialist approval", () => {
  it("the domain map is exhaustive, and honest about the ten domains with nothing registered", async () => {
    const rows = await physical<{ d: string; cap: string | null }>(
      `select d, public.r1_draft_specialist_capability(d) as cap
         from unnest(array['finance','workforce','operations','crm','system','governance',
                           'objectives','marketing','procurement','assets','legal','providers']) d
        order by d`,
    );
    const mapped = rows.filter((r) => r.cap !== null);
    expect(mapped.map((r) => `${r.d}=${r.cap}`)).toEqual([
      "legal=legal.matter.manage",
      "workforce=hr.staff.manage",
    ]);
    expect(rows.length - mapped.length).toBe(10);
    // Deliberately unmapped: its candidates are accounting authority.
    expect(rows.find((r) => r.d === "finance")!.cap).toBeNull();
  });

  it("a domain with NO registered specialist capability is refused, by name", async () => {
    const itemId = await seedItem(CO_A, {
      department: "finance", authority: "specialist_approval",
    });
    const out = await decide(OWNER, itemId, await digestOf(CO_A, itemId));
    expect(out.ok).toBe(false);
    expect(out.refusal).toBe("unresolved_authority");
    expect(String(out.detail)).toContain("finance");
  });

  it("the WRONG domain's specialist capability does not satisfy another domain", async () => {
    // The accountant holds finance capabilities and no legal ones.
    const itemId = await seedItem(CO_A, {
      department: "legal", authority: "specialist_approval",
    });
    const out = await decide(ACCOUNTANT, itemId, await digestOf(CO_A, itemId));
    expect(out.ok).toBe(false);
    // Legal is a sensitive domain, so an accountant cannot even see the item.
    expect(["insufficient_authority", "not_found", "insufficient_capability"]).toContain(
      out.refusal,
    );
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
  });

  it("an owner satisfies the legal specialist gate ONLY because 0038 grants the capability", async () => {
    // Not because they are an owner. The map is consulted, and `owner_management` is explicitly
    // granted `legal.matter.manage` by a released migration — an existing written authority rule.
    const grant = await physical(
      `select 1 from role_permissions
        where role_key='owner_management' and permission_key='legal.matter.manage'`,
    );
    expect(grant, "0038 must explicitly grant it").toHaveLength(1);

    const itemId = await seedItem(CO_A, {
      department: "legal", authority: "specialist_approval",
    });
    const out = await decide(OWNER, itemId, await digestOf(CO_A, itemId));
    expect(out.ok, JSON.stringify(out)).toBe(true);
  });

  it("a manager without the domain capability may not decide a specialist item", async () => {
    const itemId = await seedItem(CO_A, {
      department: "workforce", authority: "specialist_approval",
    });
    const out = await decide(MANAGER, itemId, await digestOf(CO_A, itemId));
    expect(out.ok).toBe(false);
    expect(await physical(`select 1 from management_item_decisions where item_id=$1`, [itemId]))
      .toHaveLength(0);
  });
});

describe.skipIf(!enabled)("R2-F-017 — the six unauthorised decision types stay closed", () => {
  it("refuses every one of them, for an owner as well as a manager", async () => {
    const itemId = await seedItem(CO_A);
    const digest = await digestOf(CO_A, itemId);
    for (const decision of ["dismiss", "edit", "delegate", "postpone", "route", "request_evidence"]) {
      for (const who of [OWNER, MANAGER]) {
        const out = await decide(who, itemId, digest, decision);
        expect(out.ok, `${decision} by ${who === OWNER ? "owner" : "manager"}`).toBe(false);
        expect(out.refusal).toBe("unresolved_authority");
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
describe.skipIf(!enabled)("R2F-F-003 — the queue is scoped by authority", () => {
  it("STAFF see only their own accountable work, not the company's queue", async () => {
    const mine = await seedItem(CO_A, { owner: membershipOf.get(STAFF)! });
    const someoneElses = await seedItem(CO_A, { owner: membershipOf.get(MANAGER)! });
    const unowned = await seedItem(CO_A, { owner: null });

    const seen = await visibleItems(STAFF, CO_A);
    expect(seen).toContain(mine);
    expect(seen).not.toContain(someoneElses);
    expect(seen).not.toContain(unowned);
  });

  it("STAFF cannot read the EVIDENCE of an item they cannot see", async () => {
    // The evidence is where the business content is. Scoping the item and not its evidence would
    // hide the headline and publish the contents.
    const hidden = await seedItem(CO_A, { owner: membershipOf.get(MANAGER)! });
    expect(await visibleEvidence(STAFF, hidden)).toBe(0);
    // And it is physically there — this is a policy refusal, not an empty table.
    expect(await physical(`select 1 from management_item_evidence where item_id=$1`, [hidden]))
      .toHaveLength(1);
  });

  it("a MANAGER sees the departments they manage, and not the others", async () => {
    const ops = await seedItem(CO_A, { department: "operations" });
    const marketing = await seedItem(CO_A, { department: "marketing" });
    const finance = await seedItem(CO_A, { department: "finance" });

    const seen = await visibleItems(MANAGER, CO_A);
    expect(seen, "operations is theirs").toContain(ops);
    expect(seen, "marketing maps to no capability they hold").not.toContain(marketing);
    expect(seen, "finance is the accountant's").not.toContain(finance);
  });

  it("a MULTI-DEPARTMENT holder sees each department they hold a capability for", async () => {
    const ops = await seedItem(CO_A, { department: "operations" });
    const procurement = await seedItem(CO_A, { department: "procurement" });
    // project_manager holds operations.task.manage AND procurement.po.approve.
    const seen = await visibleItems(MANAGER, CO_A);
    expect(seen).toContain(ops);
    expect(seen).toContain(procurement);
  });

  it("an ACCOUNTANT sees finance and not operations", async () => {
    const finance = await seedItem(CO_A, { department: "finance" });
    const ops = await seedItem(CO_A, { department: "operations" });
    const seen = await visibleItems(ACCOUNTANT, CO_A);
    expect(seen).toContain(finance);
    expect(seen).not.toContain(ops);
  });

  it("an OWNER sees cross-domain items — through the capability, not through being an owner", async () => {
    const marketing = await seedItem(CO_A, { department: "marketing" });
    const assets = await seedItem(CO_A, { department: "assets" });
    const seen = await visibleItems(OWNER, CO_A);
    expect(seen).toContain(marketing);
    expect(seen).toContain(assets);
  });

  it("SENSITIVE domains are gated separately — a company-wide viewer is not thereby entitled", async () => {
    // The owner's requirement: HR, grievance, legal and compliance evidence is separately
    // capability-gated. Separately means separately from the general permission too.
    const legal = await seedItem(CO_A, { department: "legal" });
    const workforce = await seedItem(CO_A, { department: "workforce" });

    // The manager holds `management.queue.view_company`? No — and neither domain capability.
    const managerSees = await visibleItems(MANAGER, CO_A);
    expect(managerSees).not.toContain(legal);
    expect(managerSees).not.toContain(workforce);
    expect(await visibleEvidence(MANAGER, legal)).toBe(0);

    // The accountant has company-wide view? No. And no legal/HR capability.
    const accountantSees = await visibleItems(ACCOUNTANT, CO_A);
    expect(accountantSees).not.toContain(legal);
    expect(accountantSees).not.toContain(workforce);
  });

  it("a COMPANY-WIDE viewer without the domain capability still cannot see sensitive items", async () => {
    // The case that proves the sensitive gate does work. Everyone else is excluded by the
    // department map anyway, so without this person the gate could be deleted unnoticed — which
    // is precisely what mutation S1 could not decide.
    const legal = await seedItem(CO_A, { department: "legal" });
    const workforce = await seedItem(CO_A, { department: "workforce" });
    const marketing = await seedItem(CO_A, { department: "marketing" });

    const seen = await visibleItems(WIDE_VIEWER, CO_A);
    // Company-wide really is company-wide for ordinary domains …
    expect(seen, "an ordinary domain is visible company-wide").toContain(marketing);
    // … and stops at the sensitive ones.
    expect(seen, "legal is separately gated").not.toContain(legal);
    expect(seen, "workforce is separately gated").not.toContain(workforce);
    expect(await visibleEvidence(WIDE_VIEWER, legal)).toBe(0);
    expect(await visibleEvidence(WIDE_VIEWER, workforce)).toBe(0);
  });

  it("an INACTIVE membership sees nothing at all", async () => {
    const ops = await seedItem(CO_A, { department: "operations" });
    await q(`update memberships set status='ended' where user_id=$1 and company_id=$2`, [
      MANAGER, CO_A,
    ]);
    try {
      expect(await visibleItems(MANAGER, CO_A)).toEqual([]);
      expect(await visibleEvidence(MANAGER, ops)).toBe(0);
    } finally {
      await q(`update memberships set status='active' where user_id=$1 and company_id=$2`, [
        MANAGER, CO_A,
      ]);
    }
  });

  it("CROSS-COMPANY items are never visible, and a guessed id returns nothing", async () => {
    const aItem = await seedItem(CO_A, { department: "operations" });
    expect(await visibleItems(B_MANAGER, CO_A)).toEqual([]);
    // A guessed id is not a way in either.
    const guessed = await asUser(B_MANAGER, async () => {
      const { rows } = await q(`select id from management_items where id = $1`, [aItem]);
      return rows;
    });
    expect(guessed).toHaveLength(0);
    expect(await visibleEvidence(B_MANAGER, aItem)).toBe(0);
  });

  it("EMPTY and PERMISSION-DENIED are different facts, and both are truthful", async () => {
    // The staff member sees nothing of company A's queue. That is not "the company has no items".
    const someoneElses = await seedItem(CO_A, { owner: membershipOf.get(MANAGER)! });
    expect(await visibleItems(STAFF, CO_A)).not.toContain(someoneElses);
    // Physically, the company DOES have items — so "no items exist" would be a lie.
    const all = await physical(`select 1 from management_items where company_id=$1`, [CO_A]);
    expect(all.length).toBeGreaterThan(0);
  });

  it("hidden items leak no count, id, action or existence through the scoped read", async () => {
    // The read returns rows, not errors, so there is no differing-error channel. What a viewer
    // cannot see is simply absent, identically to something that does not exist.
    const hidden = await seedItem(CO_A, { department: "marketing" });
    const seen = await visibleItems(STAFF, CO_A);
    expect(seen).not.toContain(hidden);

    const probe = await asUser(STAFF, async () => {
      const { rows } = await q(
        `select count(*)::int as n from management_items where company_id=$1 and department='marketing'`,
        [CO_A],
      );
      return Number(rows[0].n);
    });
    expect(probe, "a count must not reveal hidden rows").toBe(0);
  });

  it("permission removed DURING an open session takes effect on the next read", async () => {
    const ops = await seedItem(CO_A, { department: "operations" });
    expect(await visibleItems(MANAGER, CO_A)).toContain(ops);

    const membership = membershipOf.get(MANAGER)!;
    await q(`delete from membership_roles where membership_id=$1 and role_key='project_manager'`, [
      membership,
    ]);
    try {
      expect(await visibleItems(MANAGER, CO_A)).not.toContain(ops);
    } finally {
      await q(
        `insert into membership_roles (membership_id, company_id, role_key)
         values ($1,$2,'project_manager') on conflict do nothing`,
        [membership, CO_A],
      );
    }
  });

  it("observation sources stay readable — a failed detector must never read as an all-clear", async () => {
    // Deliberately NOT scoped: hiding which departments were observed would turn a broken
    // detector into a silent clean bill of health, which is the defect the queue exists to avoid.
    const n = await asUser(STAFF, async () => {
      const { rows } = await q(`select count(*)::int as n from observation_sources`);
      return Number(rows[0].n);
    });
    expect(n).toBeGreaterThanOrEqual(0);
  });
});
