/**
 * R2S-F-007 — the DATE columns must not shift a day when the server is east of UTC.
 *
 * This system runs a Sri Lankan business at UTC+5:30. `pg` materialises a `date` column as a Date
 * at LOCAL midnight, so `toISOString().slice(0, 10)` moves it to the PREVIOUS day — every licence
 * expiry, insurance expiry, invoice due date and objective boundary read one day early. The test
 * suite runs in UTC, where the defect is completely invisible, which is exactly why this file
 * sets the timezone explicitly rather than trusting the environment it happens to run in.
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { iso, isoDate } from "@/kernel/temporal";

const savedTZ = process.env.TZ;

/** Build the Date `pg` would produce for a `date` column: LOCAL midnight on that day. */
const pgDate = (y: number, m: number, d: number) => new Date(y, m - 1, d);

describe("isoDate keeps the calendar day, in every timezone", () => {
  const cases: Array<[string, [number, number, number], string]> = [
    ["Asia/Colombo", [2026, 9, 2], "2026-09-02"],   // UTC+5:30 — the deployment timezone
    ["Asia/Tokyo", [2026, 1, 1], "2026-01-01"],     // UTC+9, and a year boundary
    ["Pacific/Kiritimati", [2026, 3, 15], "2026-03-15"], // UTC+14, the extreme case
    ["UTC", [2026, 9, 2], "2026-09-02"],
    ["America/Los_Angeles", [2026, 9, 2], "2026-09-02"], // west of UTC, the other direction
  ];

  for (const [tz, [y, m, d], expected] of cases) {
    it(`${tz}: a date column of ${expected} reads back as ${expected}`, () => {
      process.env.TZ = tz;
      expect(isoDate(pgDate(y, m, d))).toBe(expected);
    });
  }

  afterAll(() => {
    if (savedTZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedTZ;
  });
});

describe("the specific failure that was shipping", () => {
  beforeAll(() => { process.env.TZ = "Asia/Colombo"; });
  afterAll(() => {
    if (savedTZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedTZ;
  });

  it("does NOT report a licence expiring today as having expired yesterday", () => {
    const today = pgDate(2026, 9, 2);
    expect(isoDate(today)).toBe("2026-09-02");
    // The UTC route is what was wrong; asserted so the difference is visible in the test itself.
    expect(today.toISOString().slice(0, 10)).toBe("2026-09-01");
  });

  it("does NOT move a due date on the 1st into the previous month", () => {
    expect(isoDate(pgDate(2026, 3, 1))).toBe("2026-03-01");
  });

  it("does NOT move a period start across a year boundary", () => {
    expect(isoDate(pgDate(2026, 1, 1))).toBe("2026-01-01");
  });
});

describe("string inputs are taken verbatim, not re-parsed through a zone", () => {
  beforeAll(() => { process.env.TZ = "Asia/Colombo"; });
  afterAll(() => {
    if (savedTZ === undefined) delete process.env.TZ;
    else process.env.TZ = savedTZ;
  });

  it("keeps a plain calendar day exactly as given", () => {
    expect(isoDate("2026-09-02")).toBe("2026-09-02");
  });

  it("keeps the day from a timestamp string without shifting it", () => {
    expect(isoDate("2026-09-02T23:30:00.000Z")).toBe("2026-09-02");
  });
});

describe("iso() handles instants, and both refuse to invent a value", () => {
  it("normalises a Date to a UTC instant", () => {
    expect(iso(new Date(Date.UTC(2026, 8, 2, 6, 30)))).toBe("2026-09-02T06:30:00.000Z");
  });

  it("normalises a timestamp string", () => {
    expect(iso("2026-09-02T06:30:00Z")).toBe("2026-09-02T06:30:00.000Z");
  });

  it("returns null for absent, unreadable and invalid values rather than a fabricated date", () => {
    for (const v of [null, undefined, "", "not a date", new Date("nonsense")]) {
      expect(iso(v), `iso(${String(v)})`).toBeNull();
      expect(isoDate(v), `isoDate(${String(v)})`).toBeNull();
    }
  });
});
