"use server";

import { resolveCapability } from "@/lib/auth";
import { WINDOW_SPECS } from "@/components/spatial/windowSpecs";
import { loadFinanceData } from "@/components/spatial/panels/FinancePanel";
import { loadStaffData } from "@/components/spatial/panels/StaffPanel";
import { loadProjectsData } from "@/components/spatial/panels/ProjectsPanel";
import { loadCustomersData } from "@/components/spatial/panels/CustomersPanel";
import { loadVehiclesData } from "@/components/spatial/panels/VehiclesPanel";
import { loadPurchaseOrdersData } from "@/components/spatial/panels/PurchaseOrdersPanel";
import { loadRisksData } from "@/components/spatial/panels/RisksPanel";
import { loadSystemHealthData } from "@/components/spatial/panels/SystemHealthPanel";

export type PlainObject = Record<string, unknown>;

const LOADER_BY_TYPE: Record<string, (companyId: string, userId?: string) => Promise<PlainObject>> = {
  finance: loadFinanceData,
  staff: loadStaffData,
  projects: loadProjectsData,
  customers: loadCustomersData,
  vehicles: loadVehiclesData,
  "purchase-orders": loadPurchaseOrdersData,
  risks: loadRisksData,
  "system-health": loadSystemHealthData,
};

export async function loadModuleData(
  type: string,
  companyId: string,
  userId?: string,
): Promise<{ ok: true; data: PlainObject } | { ok: false; error: string }> {
  const loader = LOADER_BY_TYPE[type];
  if (!loader) {
    return { ok: false, error: `Unknown module type: ${type}` };
  }
  try {
    const data = await loader(companyId, userId);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: (e as Error).message ?? "Failed to load module data" };
  }
}

/**
 * Resolve which registered module types the given user is allowed to open.
 * The registry remains the single source of truth; this function only checks
 * the capability gate for each spec's requiredCapabilities. Empty lists mean
 * unrestricted (e.g. command centre, AI recommendations, system health).
 */
export async function resolveAllowedModules(userId: string, companyId: string): Promise<string[]> {
  const allowed: string[] = [];
  for (const spec of WINDOW_SPECS) {
    const caps = spec.requiredCapabilities ?? [];
    if (caps.length === 0) {
      allowed.push(spec.type);
      continue;
    }
    const results = await Promise.all(
      caps.map((cap) => resolveCapability(userId, companyId, cap)),
    );
    if (results.every((r) => r === "granted")) {
      allowed.push(spec.type);
    }
  }
  return allowed;
}
