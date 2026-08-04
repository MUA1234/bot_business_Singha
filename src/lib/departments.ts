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
      { href: "/app/admin/employees", label: "Employees", icon: "users" },
      { href: "/app/admin/departments", label: "Departments", icon: "building-2" },
      { href: "/app/admin/catalog", label: "Products & Prices", icon: "tag" },
      { href: "/app/sales", label: "Sales & Orders", icon: "shopping-cart" },
      { href: "/app/finance", label: "Finance", icon: "wallet" },
      { href: "/app/marketing", label: "Marketing", icon: "megaphone" },
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
      { href: "/app/sales/customers", label: "Customers", icon: "user-round" },
    ],
  },
  {
    key: "finance",
    label: "Finance",
    icon: "wallet",
    description: "Invoices, payments, approvals, ledger exports.",
    nav: [
      { href: "/app/finance", label: "Overview", icon: "home" },
      { href: "/app/finance/invoices", label: "Invoices", icon: "file-text" },
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
    ],
  },
];

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
