import { describe, it, expect } from "vitest";
import { isOnLeave, evaluateAvailability, rankAvailableCandidates, selectBestAvailable } from "@/modules/work/availability";
import type { CapacityResult } from "@/modules/work/capacity";

const healthyCapacity = (allocated = 0): CapacityResult => ({
  totalHours: 40,
  netCapacityHours: 36,
  allocatedHours: allocated,
  availableHours: 36 - allocated,
  utilizationPct: 0,
  status: "healthy",
});

describe("SCH-003 availability helpers", () => {
  it("isOnLeave returns false when no approved leave ranges exist", () => {
    expect(isOnLeave("2026-08-23", [])).toBe(false);
  });

  it("isOnLeave returns true when the date is inside an approved range", () => {
    expect(isOnLeave("2026-08-23", [{ start: "2026-08-20", end: "2026-08-25" }])).toBe(true);
  });

  it("isOnLeave returns true for boundary dates", () => {
    expect(isOnLeave("2026-08-20", [{ start: "2026-08-20", end: "2026-08-22" }])).toBe(true);
    expect(isOnLeave("2026-08-22", [{ start: "2026-08-20", end: "2026-08-22" }])).toBe(true);
  });

  it("isOnLeave returns false when the date is outside all ranges", () => {
    expect(isOnLeave("2026-08-26", [{ start: "2026-08-20", end: "2026-08-25" }])).toBe(false);
  });

  it("evaluateAvailability marks a person on leave as unavailable", () => {
    const result = evaluateAvailability(
      { profileId: "u1", approvedLeave: [{ start: "2026-08-23", end: "2026-08-25" }], capacity: healthyCapacity() },
      "2026-08-23",
    );
    expect(result.available).toBe(false);
    expect(result.onLeave).toBe(true);
    expect(result.profileId).toBe("u1");
  });

  it("evaluateAvailability marks a person not on leave as available", () => {
    const result = evaluateAvailability(
      { profileId: "u2", approvedLeave: [{ start: "2026-08-20", end: "2026-08-22" }], capacity: healthyCapacity() },
      "2026-08-23",
    );
    expect(result.available).toBe(true);
    expect(result.onLeave).toBe(false);
  });

  it("rankAvailableCandidates puts available people before unavailable ones", () => {
    const candidates = [
      evaluateAvailability({ profileId: "away", approvedLeave: [{ start: "2026-08-23", end: "2026-08-25" }], capacity: healthyCapacity() }, "2026-08-23"),
      evaluateAvailability({ profileId: "free", approvedLeave: [], capacity: healthyCapacity(5) }, "2026-08-23"),
      evaluateAvailability({ profileId: "busy", approvedLeave: [], capacity: healthyCapacity(30) }, "2026-08-23"),
    ];
    const ranked = rankAvailableCandidates(candidates);
    expect(ranked.map((c) => c.profileId)).toEqual(["free", "busy", "away"]);
  });

  it("rankAvailableCandidates sorts available people by most free hours first", () => {
    const candidates = [
      evaluateAvailability({ profileId: "busy", approvedLeave: [], capacity: healthyCapacity(30) }, "2026-08-23"),
      evaluateAvailability({ profileId: "free", approvedLeave: [], capacity: healthyCapacity(5) }, "2026-08-23"),
      evaluateAvailability({ profileId: "medium", approvedLeave: [], capacity: healthyCapacity(15) }, "2026-08-23"),
    ];
    const ranked = rankAvailableCandidates(candidates);
    expect(ranked.map((c) => c.profileId)).toEqual(["free", "medium", "busy"]);
  });

  it("selectBestAvailable returns the most available candidate", () => {
    const candidates = [
      evaluateAvailability({ profileId: "away", approvedLeave: [{ start: "2026-08-23", end: "2026-08-25" }], capacity: healthyCapacity() }, "2026-08-23"),
      evaluateAvailability({ profileId: "busy", approvedLeave: [], capacity: healthyCapacity(30) }, "2026-08-23"),
      evaluateAvailability({ profileId: "free", approvedLeave: [], capacity: healthyCapacity(5) }, "2026-08-23"),
    ];
    const best = selectBestAvailable(candidates);
    expect(best?.profileId).toBe("free");
  });

  it("selectBestAvailable returns null when nobody is available", () => {
    const candidates = [
      evaluateAvailability({ profileId: "away1", approvedLeave: [{ start: "2026-08-23", end: "2026-08-25" }], capacity: healthyCapacity() }, "2026-08-23"),
      evaluateAvailability({ profileId: "away2", approvedLeave: [{ start: "2026-08-23", end: "2026-08-24" }], capacity: healthyCapacity() }, "2026-08-23"),
    ];
    expect(selectBestAvailable(candidates)).toBeNull();
  });
});
