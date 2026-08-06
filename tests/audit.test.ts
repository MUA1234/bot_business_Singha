import { describe, it, expect, vi } from "vitest";
import { writeAudit, writeAuditStrict, AuditError, type AuditInserter } from "@/lib/audit";

const entry = {
  companyId: "co",
  actorId: "u1",
  action: "customer_invoice.posted",
  entityType: "customer_invoice",
  entityId: "inv1",
};

const okInserter: AuditInserter = async () => ({ error: null });
const failInserter: AuditInserter = async () => ({ error: { message: "permission denied" } });
const throwInserter: AuditInserter = async () => {
  throw new Error("connection reset");
};

describe("writeAudit (best-effort, but surfaced)", () => {
  it("returns ok on success and passes a well-formed row", async () => {
    const spy = vi.fn(okInserter);
    const res = await writeAudit(entry, spy);
    expect(res.ok).toBe(true);
    const row = spy.mock.calls[0]![0];
    expect(row).toMatchObject({ company_id: "co", actor_id: "u1", action: "customer_invoice.posted", actor_type: "user" });
  });

  it("does NOT silently swallow a returned {error} — surfaces it", async () => {
    const res = await writeAudit(entry, failInserter);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/permission denied/);
  });

  it("catches a thrown transport error and reports it", async () => {
    const res = await writeAudit(entry, throwInserter);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/connection reset/);
  });
});

describe("writeAuditStrict (fail-closed)", () => {
  it("resolves when the audit is recorded", async () => {
    await expect(writeAuditStrict(entry, okInserter)).resolves.toBeUndefined();
  });

  it("throws AuditError when the audit cannot be recorded", async () => {
    await expect(writeAuditStrict(entry, failInserter)).rejects.toBeInstanceOf(AuditError);
  });

  it("throws when the inserter itself throws", async () => {
    await expect(writeAuditStrict(entry, throwInserter)).rejects.toBeInstanceOf(AuditError);
  });
});
