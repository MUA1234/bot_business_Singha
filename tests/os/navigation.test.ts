/**
 * The command rail must never lose a route, and must never invent one.
 *
 * The Spatial Executive OS replaces the per-department sidebar with a rail of
 * destinations. Entitlement still comes from the department catalog, so the
 * rail has exactly two obligations, both asserted here for EVERY department:
 *
 *   1. NOTHING IS LOST — every NavItem the department grants is reachable,
 *      either as a destination or inside one. A route that no destination
 *      claims must be surfaced as "unclaimed" rather than silently dropped.
 *
 *   2. NOTHING IS GAINED — a destination is offered only when the department's
 *      own nav already contains one of its routes. The rail can never become a
 *      way around a permission.
 */
import { describe, it, expect } from "vitest";
import { DEPARTMENTS } from "@/lib/departments";
import {
  OS_DESTINATIONS,
  resolveDestinations,
  unclaimedRoutes,
  currentDestination,
  domainForPath,
} from "@/lib/os-navigation";

describe("Spatial OS navigation", () => {
  it("loses no route for any department", () => {
    for (const dept of DEPARTMENTS) {
      const destinations = resolveDestinations(dept.nav);
      const unclaimed = unclaimedRoutes(dept.nav);

      const reachable = new Set<string>();
      for (const d of destinations) for (const child of d.children) reachable.add(child.href);
      for (const item of unclaimed) reachable.add(item.href);

      for (const item of dept.nav) {
        expect(
          reachable.has(item.href),
          `${dept.key}: ${item.href} is not reachable from the rail`,
        ).toBe(true);
      }
    }
  });

  it("offers no destination the department was not already entitled to", () => {
    for (const dept of DEPARTMENTS) {
      const entitled = dept.nav.map((n) => n.href);
      for (const d of resolveDestinations(dept.nav)) {
        // Every destination must hold at least one route the department has.
        const holdsEntitled = d.children.some((c) => entitled.includes(c.href));
        expect(holdsEntitled, `${dept.key}: destination ${d.key} was not entitled`).toBe(true);
        // Its doorway must be one of those entitled routes, not an invented one.
        expect(entitled).toContain(d.href);
      }
    }
  });

  it("sends the rail to the shortest entitled route, not to a leaf", () => {
    const finance = DEPARTMENTS.find((d) => d.key === "finance")!;
    const dest = resolveDestinations(finance.nav).find((d) => d.key === "finance");
    expect(dest).toBeDefined();
    expect(dest!.href).toBe("/app/finance");
  });

  it("resolves the current destination by longest prefix", () => {
    const admin = DEPARTMENTS.find((d) => d.key === "admin")!;
    const destinations = resolveDestinations(admin.nav);

    expect(currentDestination(destinations, "/app/finance/journals/abc")?.key).toBe("finance");
    expect(currentDestination(destinations, "/app/operations/tasks/42")?.key).toBe("work");
    expect(currentDestination(destinations, "/app/operations/projects/7")?.key).toBe("projects");
    // An unmapped route resolves to nothing rather than to a wrong destination.
    expect(currentDestination(destinations, "/app/nowhere")).toBeNull();
  });

  it("does not let a prefix collision claim a more specific route", () => {
    // /app/operations/projects is more specific than /app/operations, and must
    // win — otherwise opening a project highlights "Work" in the rail.
    const admin = DEPARTMENTS.find((d) => d.key === "admin")!;
    const destinations = resolveDestinations(admin.nav);
    expect(currentDestination(destinations, "/app/operations/projects")?.key).toBe("projects");
    expect(currentDestination(destinations, "/app/operations")?.key).toBe("work");
  });

  it("gives every destination a unique key and at least one route", () => {
    const keys = OS_DESTINATIONS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const d of OS_DESTINATIONS) {
      expect(d.routes.length).toBeGreaterThan(0);
      expect(d.label.length).toBeGreaterThan(0);
    }
  });

  it("lights the room by domain, defaulting rather than throwing", () => {
    expect(domainForPath("/app/finance/pnl")).toBe("finance");
    expect(domainForPath("/app/hr/capacity")).toBe("people");
    expect(domainForPath("/app/sales/leads")).toBe("crm");
    expect(domainForPath("/app/totally/unknown")).toBe("command");
  });
});
