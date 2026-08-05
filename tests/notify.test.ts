import { describe, it, expect } from "vitest";
import { unreadCount } from "@/lib/notify";

describe("notifications (change plan §10 UX)", () => {
  it("counts unread", () => {
    expect(unreadCount([])).toBe(0);
    expect(unreadCount([{ is_read: false }, { is_read: true }, { is_read: false }])).toBe(2);
    expect(unreadCount([{ is_read: true }, { is_read: true }])).toBe(0);
  });
});
