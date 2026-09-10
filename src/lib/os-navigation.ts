/**
 * Spatial Executive OS — navigation model.
 *
 * The command rail replaces the permanent sidebar, but it must NOT reduce what
 * the user can reach. This module maps every route in the department catalog
 * (`src/lib/departments.ts` — still the single source of truth for who may see
 * what) onto a spatial DESTINATION, and keeps the rest of that department's
 * links as the destination's sub-navigation.
 *
 * Two invariants, both load-bearing:
 *
 *   1. NOTHING IS LOST. Every `NavItem` the user is entitled to appears
 *      somewhere — as a destination or inside one. `assertNavCoverage()` proves
 *      it, and a test asserts it for every department.
 *
 *   2. NOTHING IS GAINED. A destination is offered only when the user's own
 *      department nav already contains at least one of its routes. The rail
 *      never widens access; it re-presents the access the user already has.
 */
import type { NavItem } from "./departments";

export type OsDomain =
  | "command"
  | "finance"
  | "people"
  | "projects"
  | "operations"
  | "crm"
  | "ai";

export interface OsDestination {
  /** Stable key, used for the current-location test and analytics. */
  key: string;
  /** Rail label. Short — the rail is thin. */
  label: string;
  /** Longer name used by the command palette and the flyout. */
  title: string;
  icon: string;
  /** Which environmental character this destination is lit with. */
  domain: OsDomain;
  /**
   * Route prefixes that belong to this destination, most specific first. A
   * destination is OFFERED when the user's nav contains any of these, and is
   * CURRENT when the pathname starts with one of them.
   */
  routes: string[];
  /** Rail grouping caption. */
  section: "control" | "work" | "money" | "relations" | "operate" | "govern" | "platform";
}

/**
 * The destinations, in rail order. Ordering is by how often an executive or a
 * member of staff actually reaches for them, not alphabetically and not by
 * subsystem.
 */
export const OS_DESTINATIONS: OsDestination[] = [
  {
    key: "command",
    label: "Command",
    title: "Command Centre",
    icon: "radar",
    domain: "command",
    section: "control",
    routes: [
      "/app/command",
      "/app/portfolio",
      "/app/admin/objectives",
      "/app/admin",
    ],
  },
  {
    key: "me",
    label: "My Work",
    title: "My Work — personal cockpit",
    icon: "compass",
    domain: "command",
    section: "control",
    routes: ["/app/me"],
  },
  {
    key: "work",
    label: "Work",
    title: "Work — tasks and assignments",
    icon: "list-todo",
    domain: "projects",
    section: "work",
    routes: ["/app/operations/tasks", "/app/operations"],
  },
  {
    key: "projects",
    label: "Projects",
    title: "Projects — command room",
    icon: "git-branch",
    domain: "projects",
    section: "work",
    routes: ["/app/operations/projects"],
  },
  {
    key: "calendar",
    label: "Calendar",
    title: "Calendar & commitments",
    icon: "calendar-days",
    domain: "projects",
    section: "work",
    routes: ["/app/calendar"],
  },
  {
    key: "people",
    label: "People",
    title: "People & workforce",
    icon: "users",
    domain: "people",
    section: "work",
    routes: [
      "/app/hr",
      "/app/admin/employees",
      "/app/admin/departments",
    ],
  },
  {
    key: "finance",
    label: "Finance",
    title: "Finance command centre",
    icon: "wallet",
    domain: "finance",
    section: "money",
    routes: ["/app/finance"],
  },
  {
    key: "customers",
    label: "Customers",
    title: "Customer relationship field",
    icon: "user-round",
    domain: "crm",
    section: "relations",
    routes: ["/app/sales"],
  },
  {
    key: "comms",
    label: "Messages",
    title: "Communications",
    icon: "message-square",
    domain: "crm",
    section: "relations",
    routes: [
      "/app/messages",
      "/app/notifications",
      "/app/admin/inbound-review",
      "/app/admin/inbound-setup",
    ],
  },
  {
    key: "marketing",
    label: "Marketing",
    title: "Marketing & campaigns",
    icon: "megaphone",
    domain: "crm",
    section: "relations",
    routes: ["/app/marketing"],
  },
  {
    key: "procurement",
    label: "Supply",
    title: "Procurement & suppliers",
    icon: "truck",
    domain: "operations",
    section: "operate",
    routes: ["/app/procurement"],
  },
  {
    key: "assets",
    label: "Assets",
    title: "Asset control tower",
    icon: "boxes",
    domain: "operations",
    section: "operate",
    routes: ["/app/fleet"],
  },
  {
    key: "catalog",
    label: "Catalogue",
    title: "Products & prices",
    icon: "tag",
    domain: "operations",
    section: "operate",
    routes: ["/app/admin/catalog"],
  },
  {
    key: "risks",
    label: "Risk",
    title: "Risk, legal & governance",
    icon: "shield-alert",
    domain: "operations",
    section: "govern",
    routes: ["/app/legal"],
  },
  {
    key: "documents",
    label: "Documents",
    title: "Documents & knowledge",
    icon: "folder-open",
    domain: "operations",
    section: "govern",
    routes: ["/app/documents"],
  },
  {
    key: "ai",
    label: "AI",
    title: "AI operations",
    icon: "sparkles",
    domain: "ai",
    section: "platform",
    routes: [
      "/app/ai",
      "/app/command/analyze",
      "/app/command/memory",
      "/app/admin/model-budgets",
      "/app/admin/directives",
    ],
  },
  {
    key: "health",
    label: "Health",
    title: "System health & audit",
    icon: "heart-pulse",
    domain: "command",
    section: "platform",
    routes: [
      "/app/admin/health",
      "/app/command/health",
      "/app/admin/outbox",
      "/app/admin/integrations",
      "/app/admin/audit",
    ],
  },
];

export const SECTION_LABEL: Record<OsDestination["section"], string> = {
  control: "Control",
  work: "Work",
  money: "Money",
  relations: "Relations",
  operate: "Operate",
  govern: "Govern",
  platform: "Platform",
};

/** Longest-prefix match: the most specific destination that claims this route. */
function destinationForHref(href: string): OsDestination | null {
  let best: OsDestination | null = null;
  let bestLen = -1;
  for (const dest of OS_DESTINATIONS) {
    for (const route of dest.routes) {
      const matches = href === route || href.startsWith(route + "/");
      if (matches && route.length > bestLen) {
        best = dest;
        bestLen = route.length;
      }
    }
  }
  return best;
}

export interface ResolvedDestination extends OsDestination {
  /** Where the rail sends the user: the shortest entitled route it holds. */
  href: string;
  /** The rest of this destination's entitled routes, for its sub-navigation. */
  children: NavItem[];
}

/**
 * Fold a department's nav into rail destinations.
 *
 * Only destinations the user already has a route into are returned, and each
 * one carries every other entitled route it covers, so a rail item is a doorway
 * to that whole area rather than a replacement for it.
 */
export function resolveDestinations(nav: NavItem[]): ResolvedDestination[] {
  const buckets = new Map<string, NavItem[]>();

  for (const item of nav) {
    const dest = destinationForHref(item.href);
    if (!dest) continue;
    const list = buckets.get(dest.key) ?? [];
    list.push(item);
    buckets.set(dest.key, list);
  }

  const resolved: ResolvedDestination[] = [];
  for (const dest of OS_DESTINATIONS) {
    const items = buckets.get(dest.key);
    if (!items || items.length === 0) continue;

    // The doorway is the shortest entitled route — the overview, not a leaf.
    const entry = [...items].sort((a, b) => a.href.length - b.href.length)[0]!;
    resolved.push({
      ...dest,
      href: entry.href,
      children: items,
    });
  }
  return resolved;
}

/**
 * Routes the user is entitled to that no destination claims. Must always be
 * empty; surfaced by the shell as an "Other" group rather than silently
 * dropped, so a newly added department route can never disappear from the UI
 * just because this map has not been updated yet.
 */
export function unclaimedRoutes(nav: NavItem[]): NavItem[] {
  return nav.filter((item) => destinationForHref(item.href) === null);
}

/** The destination that owns the current pathname, or null on an unmapped route. */
export function currentDestination(
  destinations: ResolvedDestination[],
  pathname: string,
): ResolvedDestination | null {
  let best: ResolvedDestination | null = null;
  let bestLen = -1;
  for (const dest of destinations) {
    for (const route of dest.routes) {
      const matches = pathname === route || pathname.startsWith(route + "/");
      if (matches && route.length > bestLen) {
        best = dest;
        bestLen = route.length;
      }
    }
  }
  return best;
}

/** The environmental character for a pathname. */
export function domainForPath(pathname: string): OsDomain {
  const dest = destinationForHref(pathname);
  return dest?.domain ?? "command";
}
