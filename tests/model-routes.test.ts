import { describe, it, expect } from "vitest";
import { AI_ROUTES, resolveRoute, requiresHumanReview, isHighCost } from "@/ai/model-routes";
import { MODEL_ROUTES } from "@/ai/gateway";

describe("logical AI routes", () => {
  it("exposes the four intents", () => {
    expect(Object.keys(AI_ROUTES).sort()).toEqual(["analyze", "classify", "draft", "specialist"]);
  });

  it("specialist analysis always requires human review", () => {
    expect(requiresHumanReview("specialist")).toBe(true);
    expect(requiresHumanReview("classify")).toBe(false);
    expect(requiresHumanReview("draft")).toBe(false);
  });

  it("classification is the low-cost tier (not the most expensive)", () => {
    expect(isHighCost("classify")).toBe(false);
    expect(resolveRoute("classify").costTier).toBe("low");
  });

  it("every intent points at a real gateway route", () => {
    for (const spec of Object.values(AI_ROUTES)) {
      expect(MODEL_ROUTES[spec.gatewayRoute]).toBeDefined();
    }
  });
});
