"use server";

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
