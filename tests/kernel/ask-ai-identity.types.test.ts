/**
 * R2D — the two identities cannot be swapped, and the compiler enforces it.
 *
 * `userId` and `membershipId` are both uuids addressing different things. Interchanging them
 * type-checks under plain `string` and fails silently at runtime: the query matches nothing, so a
 * person sees an empty list rather than an error. That happened in this phase — the retrieval
 * loader scoped task assignment by membership id — and only a live schema caught it.
 *
 * `@ts-expect-error` is the discriminating half. If the brands are removed, the code beneath each
 * directive stops being an error, TypeScript reports the directive as unused, and this file fails
 * to build. It cannot quietly start passing.
 */
import { describe, expect, it } from "vitest";
import {
  requesterIdentity, asUserId, asMembershipId, asCompanyId,
  type UserId, type MembershipId, type CompanyId, type RequesterIdentity,
} from "@/kernel/ask-ai/identity";

const U = "11111111-1111-1111-1111-111111111111";
const M = "22222222-2222-2222-2222-222222222222";
const C = "33333333-3333-3333-3333-333333333333";

describe("a user id and a membership id are different types", () => {
  it("REFUSES a membership id where a user id belongs", () => {
    const membershipId = asMembershipId(M);
    // @ts-expect-error a membership id is not a user id, however similar the value looks.
    const wrong: UserId = membershipId;
    void wrong;
    expect(membershipId).toBe(M);
  });

  it("REFUSES a user id where a membership id belongs", () => {
    const userId = asUserId(U);
    // @ts-expect-error the swap in the other direction is equally refused.
    const wrong: MembershipId = userId;
    void wrong;
    expect(userId).toBe(U);
  });

  it("REFUSES a bare string for either", () => {
    // @ts-expect-error an unmarked string has not been established as an identity.
    const u: UserId = U;
    // @ts-expect-error same for a membership.
    const m: MembershipId = M;
    // @ts-expect-error and a company.
    const c: CompanyId = C;
    void u; void m; void c;
    expect(true).toBe(true);
  });

  it("REFUSES a transposed identity object", () => {
    // The exact mistake this phase actually made, now uncompilable.
    const bad: RequesterIdentity = {
      // @ts-expect-error a membership id cannot stand in for the user id.
      userId: asMembershipId(M),
      // @ts-expect-error nor a user id for the membership id.
      membershipId: asUserId(U),
      companyId: asCompanyId(C),
    };
    void bad;
    expect(true).toBe(true);
  });

  it("accepts the correctly-marked form", () => {
    const good: RequesterIdentity = {
      userId: asUserId(U),
      membershipId: asMembershipId(M),
      companyId: asCompanyId(C),
    };
    expect(good.userId).toBe(U);
    expect(good.membershipId).toBe(M);
  });
});

describe("identities must be resolved before a request proceeds", () => {
  it("builds from server-resolved values", () => {
    const id = requesterIdentity(U, M, C);
    expect(id.userId).toBe(U);
    expect(id.membershipId).toBe(M);
    expect(id.companyId).toBe(C);
  });

  it("REFUSES an empty identity rather than passing it on", () => {
    // An empty id flows onward and matches nothing — the same silent-empty-result failure the
    // brands exist to prevent, arriving through a different door.
    expect(() => requesterIdentity("", M, C)).toThrow(/userId/);
    expect(() => requesterIdentity(U, "", C)).toThrow(/membershipId/);
    expect(() => requesterIdentity(U, M, "")).toThrow(/companyId/);
  });

  it("erases the brands at runtime, so nothing is paid for this", () => {
    const id = requesterIdentity(U, M, C);
    expect(typeof id.userId).toBe("string");
    expect(JSON.parse(JSON.stringify(id))).toEqual({
      userId: U, membershipId: M, companyId: C,
    });
  });
});
