/**
 * R2D — the two identities, kept apart by the type system.
 *
 * A user id and a membership id are both uuids, and they address different things:
 *
 *   userId        `auth.users(id)` / `profiles(id)` — the PERSON. Task assignment points here.
 *   membershipId  `memberships(id)` — the person's standing IN A COMPANY. Ask-AI history,
 *                 capabilities and RLS ownership point here.
 *
 * Interchanging them type-checks perfectly and fails silently: a query scoped by the wrong one
 * matches nothing, so a person is shown an empty task list rather than an error. That already
 * happened once in this phase — the retrieval loader filtered assignment by membership id — and
 * it was found by running it against a real schema, not by reading the code.
 *
 * Branding makes the swap a compile error. The brands are erased at runtime, so this costs
 * nothing at execution time; it costs one deliberate conversion at each boundary where an
 * identity genuinely enters the system, which is exactly where the check belongs.
 */

declare const USER_BRAND: unique symbol;
declare const MEMBERSHIP_BRAND: unique symbol;
declare const COMPANY_BRAND: unique symbol;

/** `auth.users(id)` — the person. */
export type UserId = string & { readonly [USER_BRAND]: "user" };
/** `memberships(id)` — the person's standing in one company. */
export type MembershipId = string & { readonly [MEMBERSHIP_BRAND]: "membership" };
/** `companies(id)`. */
export type CompanyId = string & { readonly [COMPANY_BRAND]: "company" };

/**
 * The identity of the person making a request.
 *
 * Every field is derived SERVER-SIDE from the authenticated session. A caller-supplied user,
 * membership or company never reaches this shape — the route refuses such a request outright
 * rather than ignoring the field, so a client cannot believe it worked.
 */
export interface RequesterIdentity {
  userId: UserId;
  membershipId: MembershipId;
  companyId: CompanyId;
}

/**
 * Mark a value as a particular identity.
 *
 * Deliberately explicit and deliberately awkward to use: each call is a place where someone
 * asserted "this string is that kind of id", which is reviewable. Ordinary code passes
 * `RequesterIdentity` around and never calls these.
 */
export const asUserId = (v: string): UserId => v as UserId;
export const asMembershipId = (v: string): MembershipId => v as MembershipId;
export const asCompanyId = (v: string): CompanyId => v as CompanyId;

/**
 * Build a requester identity from values resolved server-side.
 *
 * Refuses empties, because an empty identity would otherwise flow onward and match nothing —
 * the same silent-empty-result failure the brands exist to prevent.
 */
export function requesterIdentity(
  userId: string, membershipId: string, companyId: string,
): RequesterIdentity {
  for (const [name, v] of [
    ["userId", userId], ["membershipId", membershipId], ["companyId", companyId],
  ] as const) {
    if (!v || typeof v !== "string") {
      throw new Error(`${name} must be resolved server-side before a request may proceed`);
    }
  }
  return {
    userId: asUserId(userId),
    membershipId: asMembershipId(membershipId),
    companyId: asCompanyId(companyId),
  };
}
