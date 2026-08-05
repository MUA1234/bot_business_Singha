import { describe, it, expect } from "vitest";
import { evidenceObjectPath } from "@/lib/documents";

describe("evidence object path (storage)", () => {
  it("prefixes by company and sanitises the filename", () => {
    const path = evidenceObjectPath("co-123", "abcdef0123456789ffff", "My Receipt (final).pdf");
    expect(path.startsWith("co-123/")).toBe(true);
    expect(path).toBe("co-123/abcdef0123456789-My_Receipt__final_.pdf");
  });

  it("is deterministic for the same inputs", () => {
    expect(evidenceObjectPath("c", "hash", "a.png")).toBe(evidenceObjectPath("c", "hash", "a.png"));
  });

  it("handles an empty filename", () => {
    expect(evidenceObjectPath("c", "0123456789abcdef", "")).toBe("c/0123456789abcdef-file");
  });
});
