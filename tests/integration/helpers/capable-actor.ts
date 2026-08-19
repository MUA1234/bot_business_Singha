/**
 * FOUND-006 / migration 0086 — the finance RPCs are HUMAN-ONLY.
 *
 * Before 0086 these tests presented `{"role":"service_role"}` and the RPCs took the WP17 system
 * path, which skipped the capability check. That was the shape of the G-01 defect: a claim value
 * chose a privileged branch inside a function every `authenticated` caller may EXECUTE. The branch
 * is gone, so a test that wants to post must do what a real user does — be a named human who
 * genuinely holds the capability.
 *
 * These helpers make that one line per test instead of six, and keep every finance fixture using
 * the same identity so a failure points at the RPC, not at the fixture.
 */

/** Deterministic acting human. Fixed so the claim can be set before the row exists. */
export const TEST_ACTOR = "0086ac70-0000-4000-8000-000000000001";

/** A second human, for controls that require two different people (maker–checker). */
export const TEST_ACTOR_2 = "0086ac70-0000-4000-8000-000000000002";

/** The claims a real authenticated request carries. `sub` is the identity; there is no role branch. */
export function authClaims(sub: string = TEST_ACTOR): string {
  return JSON.stringify({ role: "authenticated", sub });
}

/**
 * Give `actor` an active membership of `company` carrying `roleKey`.
 *
 * `system_administrator` is the default because it is the one seeded role that holds all nine
 * finance capabilities (`finance.journal.post`, `.invoice.post`, `.bill.post`, `.journal.reverse`,
 * `.payment.record`, `.receipt.record`, `.bank_details.request`, `.bank_details.approve`), so a
 * fixture never has to guess which capability the RPC under test will ask for. Tests that are
 * ABOUT capability enforcement pass a narrower role deliberately.
 */
export async function seedCapableActor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  client: any,
  companyId: string,
  actor: string = TEST_ACTOR,
  roleKey: string = "system_administrator",
): Promise<void> {
  await client.query(
    `insert into users (id, full_name, is_active) values ($1, 'FOUND-006 test actor', true)
       on conflict (id) do nothing`,
    [actor],
  );
  await client.query(
    `with m as (
       insert into memberships (company_id, user_id, status) values ($1, $2, 'active')
         returning id
     )
     insert into membership_roles (membership_id, company_id, role_key)
       select m.id, $1, $3 from m`,
    [companyId, actor, roleKey],
  );
}
