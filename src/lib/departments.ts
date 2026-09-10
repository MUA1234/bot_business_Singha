/**
 * Department catalog — the single source of truth for the dashboards an employee
 * can belong to. Admin assigns each employee exactly one department; on login they
 * are redirected to that department's dashboard (`/app/<key>`). `admin` is the
 * owner/administrator surface and can reach every other dashboard.
 *
 * Extensible: adding a department here + a page under `src/app/app/<key>/` and a
 * row in the `departments` table (migration 0007 seed) is all that a new dashboard
 * needs. Keep the keys in sync with the DB `departments.key` values.
 */
export interface NavItem {
  href: string;
  label: string;
  icon: string;
}

export interface Department {
  key: string;
  label: string;
  icon: string;
  description: string;
  /** Sidebar navigation for this department's dashboard. */
  nav: NavItem[];
}

export const DEPARTMENTS: Department[] = [
  {
    key: "admin",
    label: "Admin / Owner",
    icon: "crown",
    description: "Full control: employees, departments, catalog, and every dashboard.",
    nav: [
      { href: "/app/admin", label: "Overview", icon: "home" },
      { href: "/app/command", label: "Command Centre", icon: "gauge" },
      { href: "/app/portfolio", label: "Portfolio", icon: "briefcase" },
      { href: "/app/ai", label: "AI Operations", icon: "sparkles" },
      { href: "/app/command/analyze", label: "Analysis", icon: "shield" },
      { href: "/app/command/cases", label: "AI cases", icon: "sparkles" },
      { href: "/app/command/memory", label: "Memory", icon: "database" },
      { href: "/app/admin/objectives", label: "Objectives", icon: "target" },
      { href: "/app/admin/employees", label: "Employees", icon: "users" },
      { href: "/app/admin/inbound-review", label: "Inbound Review", icon: "inbox" },
      { href: "/app/admin/inbound-setup", label: "Inbound Setup", icon: "settings" },
      { href: "/app/admin/health", label: "System Health", icon: "shield" },
      { href: "/app/admin/outbox", label: "Outbox", icon: "send" },
      { href: "/app/admin/integrations", label: "Integrations", icon: "plug" },
      { href: "/app/admin/directives", label: "Directives", icon: "megaphone" },
      { href: "/app/admin/model-budgets", label: "Model Budgets", icon: "sparkles" },
      { href: "/app/admin/audit", label: "Audit Log", icon: "clipboard" },
      { href: "/app/admin/departments", label: "Departments", icon: "building-2" },
      { href: "/app/admin/catalog", label: "Products & Prices", icon: "tag" },
      { href: "/app/sales", label: "Sales & Orders", icon: "shopping-cart" },
      { href: "/app/finance", label: "Finance", icon: "wallet" },
      { href: "/app/marketing", label: "Marketing", icon: "megaphone" },
      { href: "/app/operations", label: "Operations", icon: "settings" },
      { href: "/app/operations/tasks", label: "Work", icon: "list-todo" },
      { href: "/app/operations/projects", label: "Projects", icon: "git-branch" },
      { href: "/app/hr", label: "People", icon: "user-cog" },
      { href: "/app/hr/capacity", label: "Capacity", icon: "gauge" },
      { href: "/app/procurement", label: "Procurement", icon: "truck" },
      { href: "/app/legal", label: "Legal", icon: "scale" },
      { href: "/app/fleet", label: "Fleet", icon: "car" },
    ],
  },
  {
    key: "sales",
    label: "Sales & Orders",
    icon: "shopping-cart",
    description: "WhatsApp orders, customer details, and quotations.",
    nav: [
      { href: "/app/sales", label: "Overview", icon: "home" },
      { href: "/app/sales/orders", label: "Orders", icon: "package" },
      { href: "/app/sales/quotations", label: "Quotations", icon: "file-text" },
      { href: "/app/sales/price-requests", label: "Price Confirmations", icon: "help-circle" },
      { href: "/app/sales/customers", label: "Conversations", icon: "user-round" },
      { href: "/app/sales/accounts", label: "Customer Accounts", icon: "user-round" },
      { href: "/app/sales/leads", label: "Leads", icon: "target" },
      { href: "/app/sales/opportunities", label: "Opportunities", icon: "rocket" },
    ],
  },
  {
    key: "finance",
    label: "Finance",
    icon: "wallet",
    description: "Invoices, payments, approvals, ledger exports.",
    nav: [
      { href: "/app/finance", label: "Overview", icon: "home" },
      { href: "/app/finance/chart-of-accounts", label: "Chart of Accounts", icon: "clipboard" },
      { href: "/app/finance/journals", label: "Journals", icon: "file-text" },
      { href: "/app/finance/trial-balance", label: "Trial Balance", icon: "table" },
      { href: "/app/finance/pnl", label: "Profit & Loss", icon: "table" },
      { href: "/app/finance/balance-sheet", label: "Balance Sheet", icon: "table" },
      { href: "/app/finance/periods", label: "Periods", icon: "check-circle" },
      { href: "/app/finance/customer-invoices", label: "Customer Invoices", icon: "file-text" },
      { href: "/app/finance/supplier-bills", label: "Supplier Bills", icon: "file-text" },
      { href: "/app/finance/expenses", label: "Expense Claims", icon: "wallet" },
      { href: "/app/finance/invoices", label: "Quotations", icon: "file-text" },
      { href: "/app/finance/receivables", label: "Receivables & Payables", icon: "wallet" },
      { href: "/app/finance/forecast", label: "Cash Forecast", icon: "gauge" },
      { href: "/app/finance/commitments", label: "Commitments", icon: "clipboard" },
      { href: "/app/finance/loans", label: "Loans", icon: "wallet" },
      { href: "/app/finance/tax-codes", label: "Tax Codes", icon: "clipboard" },
      { href: "/app/finance/cash-counts", label: "Cash Counts", icon: "check-circle" },
      { href: "/app/finance/accounts", label: "Bank & Cash", icon: "wallet" },
      { href: "/app/finance/reconciliation", label: "Reconciliation", icon: "check-circle" },
      { href: "/app/finance/approvals", label: "Approvals", icon: "check-circle" },
      { href: "/app/finance/price-requests", label: "Price Confirmations", icon: "help-circle" },
      { href: "/app/finance/exports", label: "Excel Exports", icon: "table" },
    ],
  },
  {
    key: "marketing",
    label: "Marketing",
    icon: "megaphone",
    description: "Campaigns, customer lists, and WhatsApp broadcasts.",
    nav: [
      { href: "/app/marketing", label: "Overview", icon: "home" },
      { href: "/app/marketing/campaigns", label: "Campaigns", icon: "rocket" },
      { href: "/app/marketing/audiences", label: "Audiences", icon: "target" },
    ],
  },
  {
    key: "operations",
    label: "Operations",
    icon: "settings",
    description: "Fulfilment, tasks, and delivery tracking.",
    nav: [
      { href: "/app/operations", label: "Overview", icon: "home" },
      { href: "/app/operations/tasks", label: "Tasks", icon: "list-todo" },
      // `/app/operations/projects` is gated by requireDepartment("operations"),
      // so this department could always reach it — it simply had no link.
      { href: "/app/operations/projects", label: "Projects", icon: "git-branch" },
    ],
  },
  {
    key: "hr",
    label: "Human Resources",
    icon: "user-cog",
    description: "Staff records and internal requests.",
    nav: [
      { href: "/app/hr", label: "Overview", icon: "home" },
      { href: "/app/hr/staff", label: "Staff", icon: "users" },
      { href: "/app/hr/capacity", label: "Capacity", icon: "gauge" },
      // `/app/hr/leave` is gated by requireDepartment("hr") and was reachable
      // by route but had no link; the HR overview points at it.
      { href: "/app/hr/leave", label: "Leave", icon: "calendar-days" },
    ],
  },
  {
    key: "procurement",
    label: "Procurement",
    icon: "truck",
    description: "Suppliers, purchase requests, and inventory.",
    nav: [
      { href: "/app/procurement", label: "Overview", icon: "home" },
      { href: "/app/procurement/suppliers", label: "Suppliers", icon: "factory" },
      { href: "/app/procurement/rfqs", label: "RFQs", icon: "help-circle" },
      { href: "/app/procurement/purchase-requests", label: "Purchase Requests", icon: "clipboard" },
      { href: "/app/procurement/purchase-orders", label: "Purchase Orders", icon: "package" },
      { href: "/app/procurement/inventory", label: "Inventory", icon: "package" },
    ],
  },
  {
    key: "legal",
    label: "Legal & Compliance",
    icon: "scale",
    description: "Matters, contracts, obligations and licence renewals.",
    nav: [
      { href: "/app/legal", label: "Overview", icon: "home" },
      { href: "/app/legal/matters", label: "Matters", icon: "clipboard" },
      { href: "/app/legal/contracts", label: "Contracts", icon: "file-text" },
      { href: "/app/legal/licences", label: "Licences", icon: "shield" },
    ],
  },
  {
    key: "fleet",
    label: "Fleet & Transport",
    icon: "car",
    description: "Vehicles, drivers, trips, fuel and maintenance.",
    nav: [
      { href: "/app/fleet", label: "Overview", icon: "home" },
      { href: "/app/fleet/vehicles", label: "Vehicles", icon: "car" },
      { href: "/app/fleet/drivers", label: "Drivers", icon: "users" },
    ],
  },
];

// Customer WhatsApp messages are visible to EVERY employee (owner instruction),
// so inject a shared "Messages" link into each department's nav, right after its
// Overview item. Keeping it here (rather than in each array above) guarantees no
// department is ever missed.
const SHARED_NAV: NavItem[] = [
  { href: "/app/me", label: "My Work", icon: "list-todo" },
  { href: "/app/notifications", label: "Notifications", icon: "message-square" },
  { href: "/app/messages", label: "Messages", icon: "message-square" },
  // Both of these assemble EXISTING company-scoped records — dated commitments
  // and stored evidence — and add no capability of their own, so every
  // department that can see those records can see them gathered.
  { href: "/app/calendar", label: "Calendar", icon: "calendar-days" },
  { href: "/app/documents", label: "Documents", icon: "folder-open" },
];
for (const d of DEPARTMENTS) {
  for (let i = 0; i < SHARED_NAV.length; i++) {
    const item = SHARED_NAV[i]!;
    if (!d.nav.some((n) => n.href === item.href)) d.nav.splice(1 + i, 0, { ...item });
  }
}

export const DEPARTMENT_KEYS = DEPARTMENTS.map((d) => d.key);

export function getDepartment(key: string | null | undefined): Department | undefined {
  return DEPARTMENTS.find((d) => d.key === key);
}

/** Where a given department lands after login. */
export function homePathFor(departmentKey: string): string {
  return `/app/${departmentKey}`;
}

/** Departments that receive price-confirmation requests. */
export const PRICE_CONFIRM_DEPARTMENTS = ["sales", "finance"] as const;
