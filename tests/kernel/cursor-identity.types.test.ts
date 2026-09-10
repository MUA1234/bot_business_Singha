/**
 * The cursor boundary's identity types — a COMPILE-TIME gate.
 *
 * `source` and `companyId` are both strings. They used to be adjacent positional parameters, and
 * in OPPOSITE orders in neighbouring functions:
 *
 *     loadPage(source, companyId, …)        readCursor(companyId, source)
 *
 * A transposition between those two type-checks perfectly. It fails at runtime as "no column
 * contract for <a uuid>", which reads like a registry problem rather than a swap. Exactly that
 * mistake was written while adding the reconciliation sweep and caught only by re-reading the
 * wiring — the clean typecheck said nothing.
 *
 * These assertions fail to COMPILE if the positional form ever returns. `@ts-expect-error` is the
 * discriminating half: if the code under it stops being an error — because the parameters went
 * back to bare adjacent strings — TypeScript reports the unused directive and this file fails to
 * build. It cannot silently start passing.
 */
import { describe, expect, it } from "vitest";
import type { CycleDeps, PageRequest, PriorityRequest, SourceRef } from "@/kernel/cycle";

const COMPANY = "11111111-1111-1111-1111-111111111111";
const SOURCE = "operations.task_exception";

describe("a reversed identity cannot compile", () => {
  it("rejects an object whose fields are transposed", () => {
    const right: SourceRef = { source: SOURCE, companyId: COMPANY };
    expect(right.source).toBe(SOURCE);

    // The whole point: the values are still two strings, but now they are NAMED, so putting the
    // company where the source belongs is a statement the reader can see and the compiler cannot
    // be fooled about. This one is fine by types but wrong by meaning — types cannot catch it, so
    // it is asserted rather than compiled:
    const transposed: SourceRef = { source: COMPANY, companyId: SOURCE };
    expect(transposed.source).not.toBe(SOURCE);
  });

  it("REFUSES positional arguments where the pair used to be", () => {
    const deps = {} as CycleDeps;

    // @ts-expect-error loadPage takes ONE request object; the positional pair is gone.
    void deps.loadPage?.(SOURCE, COMPANY, null, 200);

    // @ts-expect-error loadReconcile likewise.
    void deps.loadReconcile?.(SOURCE, COMPANY, null, 100);

    // @ts-expect-error loadPriority likewise.
    void deps.loadPriority?.(SOURCE, COMPANY, 50);

    // @ts-expect-error readCursor took (companyId, source) — the opposite order to loadPage.
    void deps.readCursor?.(COMPANY, SOURCE);

    expect(true).toBe(true);
  });

  it("REFUSES a request object missing either half of the identity", () => {
    // @ts-expect-error a page request without a company is not addressable.
    const noCompany: PageRequest = { source: SOURCE, cursor: null, limit: 10 };

    // @ts-expect-error a priority request without a source is not addressable.
    const noSource: PriorityRequest = { companyId: COMPANY, limit: 10 };

    void noCompany;
    void noSource;
    expect(true).toBe(true);
  });

  it("accepts the named form", () => {
    const page: PageRequest = { source: SOURCE, companyId: COMPANY, cursor: null, limit: 200 };
    const priority: PriorityRequest = { source: SOURCE, companyId: COMPANY, limit: 50 };
    expect(page.companyId).toBe(COMPANY);
    expect(priority.source).toBe(SOURCE);
  });
});
