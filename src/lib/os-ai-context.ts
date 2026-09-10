/**
 * Contextual AI routing.
 *
 * The AI Manager always knows which screen it was opened from. This map turns
 * that context into the questions worth asking THERE, and answers each one by
 * routing to the real screen whose real query answers it — not by generating
 * prose about it.
 *
 * Every `href` below is an existing route. A suggestion is filtered out unless
 * the user's own department nav already contains it, so this map can never
 * become a way around a permission.
 */
import type { AiSuggestion } from "@/components/os/AIManagementRoom";
import type { NavItem } from "./departments";

interface ContextRule {
  /** Route prefix this rule applies to, most specific first. */
  prefix: string;
  label: string;
  suggestions: AiSuggestion[];
}

const RULES: ContextRule[] = [
  {
    prefix: "/app/finance/approvals",
    label: "Finance approvals",
    suggestions: [
      {
        label: "What is waiting on me",
        detail: "Approvals raised to your authority, oldest first",
        href: "/app/finance/approvals",
        icon: "check-circle",
      },
      {
        label: "What we owe and when",
        detail: "Payables and receivables with ageing",
        href: "/app/finance/receivables",
        icon: "banknote",
      },
      {
        label: "Can we afford this",
        detail: "Cash forecast against committed outflows",
        href: "/app/finance/forecast",
        icon: "trending-up",
      },
    ],
  },
  {
    prefix: "/app/finance",
    label: "Finance",
    suggestions: [
      {
        label: "Where is our cash",
        detail: "Bank and cash positions across accounts",
        href: "/app/finance/accounts",
        icon: "landmark",
      },
      {
        label: "What needs a decision",
        detail: "Payment and expense approvals awaiting authority",
        href: "/app/finance/approvals",
        icon: "check-circle",
      },
      {
        label: "What is overdue",
        detail: "Receivables and payables past their due date",
        href: "/app/finance/receivables",
        icon: "clock",
      },
      {
        label: "Are we within budget",
        detail: "Budget against actual spend by line",
        href: "/app/finance/budgets",
        icon: "target",
      },
      {
        label: "What is unmatched",
        detail: "Bank lines with no matching record",
        href: "/app/finance/reconciliation",
        icon: "git-branch",
      },
    ],
  },
  {
    prefix: "/app/operations/projects",
    label: "Projects",
    suggestions: [
      {
        label: "Which projects are at risk",
        detail: "Projects with open risks or slipped milestones",
        href: "/app/operations/projects",
        icon: "shield-alert",
      },
      {
        label: "What is blocked",
        detail: "Tasks blocked or waiting on someone else",
        href: "/app/operations/tasks",
        icon: "timer",
      },
      {
        label: "Who has capacity",
        detail: "Workforce utilisation and availability",
        href: "/app/hr/capacity",
        icon: "gauge",
      },
    ],
  },
  {
    prefix: "/app/operations/tasks",
    label: "Work",
    suggestions: [
      {
        label: "What is overdue or blocked",
        detail: "Open work past its due date or waiting on a blocker",
        href: "/app/operations/tasks",
        icon: "timer",
      },
      {
        label: "Who is overloaded",
        detail: "Assigned load against declared capacity",
        href: "/app/hr/capacity",
        icon: "gauge",
      },
      {
        label: "What is mine right now",
        detail: "Your own next actions and deadlines",
        href: "/app/me",
        icon: "compass",
      },
    ],
  },
  {
    prefix: "/app/hr",
    label: "People",
    suggestions: [
      {
        label: "Who is overloaded",
        detail: "Assigned load against declared capacity",
        href: "/app/hr/capacity",
        icon: "gauge",
      },
      {
        label: "Who is unavailable",
        detail: "Approved leave and current availability",
        href: "/app/hr/leave",
        icon: "calendar-days",
      },
      {
        label: "Who is working on what",
        detail: "Open work grouped by the person who owns it",
        href: "/app/operations/tasks",
        icon: "list-todo",
      },
    ],
  },
  {
    prefix: "/app/sales",
    label: "Customers",
    suggestions: [
      {
        label: "Which customers need follow-up",
        detail: "Open opportunities and unanswered conversations",
        href: "/app/sales/opportunities",
        icon: "rocket",
      },
      {
        label: "What did we promise",
        detail: "Quotations issued and awaiting a decision",
        href: "/app/sales/quotations",
        icon: "file-text",
      },
      {
        label: "What is unpriced",
        detail: "Price confirmations waiting on a human",
        href: "/app/sales/price-requests",
        icon: "help-circle",
      },
    ],
  },
  {
    prefix: "/app/procurement",
    label: "Procurement",
    suggestions: [
      {
        label: "Compare these quotations",
        detail: "RFQ responses side by side with the evidence behind each",
        href: "/app/procurement/rfqs",
        icon: "scale",
      },
      {
        label: "What have we committed to buy",
        detail: "Open purchase orders and their delivery state",
        href: "/app/procurement/purchase-orders",
        icon: "package",
      },
      {
        label: "Which suppliers are a risk",
        detail: "Supplier records, performance and compliance",
        href: "/app/procurement/suppliers",
        icon: "factory",
      },
    ],
  },
  {
    prefix: "/app/fleet",
    label: "Assets",
    suggestions: [
      {
        label: "What is under-utilised",
        detail: "Vehicle utilisation and idle time from recorded trips",
        href: "/app/fleet/vehicles",
        icon: "car",
      },
      {
        label: "What needs maintenance",
        detail: "Maintenance, inspections and compliance dates",
        href: "/app/fleet",
        icon: "wrench",
      },
    ],
  },
  {
    prefix: "/app/legal",
    label: "Risk & governance",
    suggestions: [
      {
        label: "What is our exposure",
        detail: "Open risks with owner, deadline and mitigation",
        href: "/app/legal/risks",
        icon: "shield-alert",
      },
      {
        label: "What falls due",
        detail: "Obligations, licences and renewals by date",
        href: "/app/legal/obligations",
        icon: "gavel",
      },
      {
        label: "What have we signed",
        detail: "Contracts, their terms and their review dates",
        href: "/app/legal/contracts",
        icon: "scroll-text",
      },
    ],
  },
  {
    prefix: "/app/messages",
    label: "Communications",
    suggestions: [
      {
        label: "What is unanswered",
        detail: "Conversations with no reply from us",
        href: "/app/messages",
        icon: "message-square",
      },
      {
        label: "What was promised in conversation",
        detail: "Follow-ups and commitments captured from messages",
        href: "/app/notifications",
        icon: "bell",
      },
    ],
  },
  {
    prefix: "/app/command",
    label: "Command Centre",
    suggestions: [
      {
        label: "What needs attention today",
        detail: "Exceptions across every department, most severe first",
        href: "/app/command",
        icon: "radar",
      },
      {
        label: "What are we working towards",
        detail: "Objectives and the work attached to them",
        href: "/app/admin/objectives",
        icon: "target",
      },
      {
        label: "Is the system healthy",
        detail: "Integrations, queues, retries and stale data",
        href: "/app/admin/health",
        icon: "heart-pulse",
      },
      {
        label: "What happened and who decided it",
        detail: "The audit trail from event to outcome",
        href: "/app/admin/audit",
        icon: "scroll-text",
      },
    ],
  },
  {
    prefix: "/app/me",
    label: "My work",
    suggestions: [
      {
        label: "What should I do next",
        detail: "Your highest-priority open work",
        href: "/app/me",
        icon: "compass",
      },
      {
        label: "What is waiting on me",
        detail: "Notifications and requests addressed to you",
        href: "/app/notifications",
        icon: "bell",
      },
    ],
  },
];

/** The human name of the screen the AI is being asked about. */
export function contextLabelFor(pathname: string): string {
  let best = "this screen";
  let bestLen = -1;
  for (const rule of RULES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + "/")) {
      if (rule.prefix.length > bestLen) {
        best = rule.label;
        bestLen = rule.prefix.length;
      }
    }
  }
  return best;
}

/**
 * Context suggestions for a screen, filtered to the routes this user can
 * already reach. An entitled route the user has no nav entry for is dropped,
 * so the room never advertises a destination that would bounce them.
 */
export function suggestionsFor(pathname: string, nav: NavItem[]): AiSuggestion[] {
  let chosen: AiSuggestion[] = [];
  let bestLen = -1;
  for (const rule of RULES) {
    if (pathname === rule.prefix || pathname.startsWith(rule.prefix + "/")) {
      if (rule.prefix.length > bestLen) {
        chosen = rule.suggestions;
        bestLen = rule.prefix.length;
      }
    }
  }
  const allowed = (href: string) =>
    nav.some((item) => href === item.href || href.startsWith(item.href + "/") || item.href.startsWith(href));
  return chosen.filter((s) => allowed(s.href));
}
