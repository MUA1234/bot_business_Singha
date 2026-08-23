/**
 * WRK-001 — Attendance, availability, leave, sickness and travel.
 *
 * The HR leave page must be a real runtime entrypoint that lists leave requests,
 * joins profiles, and surfaces remaining leave using the deterministic leave
 * calculation module. Attendance/travel/working-hours remain out of scope.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const PAGE = "src/app/app/hr/leave/page.tsx";
const HR_HOME = "src/app/app/hr/page.tsx";

describe("WRK-001 — leave surface", () => {
  const page = readFileSync(PAGE, "utf8");
  const hrHome = readFileSync(HR_HOME, "utf8");

  it("has a real runtime entrypoint under /app/hr/leave", () => {
    expect(page).toContain("export default async function LeavePage");
  });

  it("queries leave_requests and joins profiles", () => {
    expect(page).toContain('from("leave_requests")');
    expect(page).toContain("profiles(full_name");
  });

  it("uses the deterministic leave calculation module for remaining leave", () => {
    expect(page).toContain('from "@/modules/workforce/leave"');
    expect(page).toContain("remainingLeave");
    expect(page).toContain("usedLeaveDays");
  });

  it("shows leave status and decided-at metadata", () => {
    expect(page).toMatch(/Leave requests/);
    expect(page).toContain("status");
    expect(page).toContain("decided_at");
  });

  it("links pending leave from the HR home to the leave page", () => {
    expect(hrHome).toContain('/app/hr/leave');
  });
});
