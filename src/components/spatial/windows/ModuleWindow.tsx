"use client";

import { useEffect, useState } from "react";
import { loadModuleData, type PlainObject } from "@/app/app/spatial/actions";
import { FinancePanelContent } from "@/components/spatial/panels/FinancePanelContent";
import { StaffPanelContent } from "@/components/spatial/panels/StaffPanelContent";
import { ProjectsPanelContent } from "@/components/spatial/panels/ProjectsPanelContent";
import { CustomersPanelContent } from "@/components/spatial/panels/CustomersPanelContent";
import { VehiclesPanelContent } from "@/components/spatial/panels/VehiclesPanelContent";
import { PurchaseOrdersPanelContent } from "@/components/spatial/panels/PurchaseOrdersPanelContent";
import { RisksPanelContent } from "@/components/spatial/panels/RisksPanelContent";
import { SystemHealthPanelContent } from "@/components/spatial/panels/SystemHealthPanelContent";
import { PageLoader } from "@/components/ui";
import type { WindowContentProps } from "../types";

const CONTENT_BY_TYPE: Record<string, React.FC<{ data: PlainObject; embedded?: boolean }>> = {
  finance: FinancePanelContent,
  staff: StaffPanelContent,
  projects: ProjectsPanelContent,
  customers: CustomersPanelContent,
  vehicles: VehiclesPanelContent,
  "purchase-orders": PurchaseOrdersPanelContent,
  risks: RisksPanelContent,
  "system-health": SystemHealthPanelContent,
};

export function ModuleWindow({ type, companyId, userId }: WindowContentProps) {
  const [state, setState] = useState<{ loading: boolean; data?: PlainObject; error?: string }>({
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true });
    loadModuleData(type, companyId, userId)
      .then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setState({ loading: false, data: res.data });
        } else {
          setState({ loading: false, error: res.error });
        }
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ loading: false, error: (e as Error).message ?? "Load failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [type, companyId, userId]);

  const Content = CONTENT_BY_TYPE[type];
  if (!Content) {
    return <div className="spatial-error">Unknown module window: {type}</div>;
  }

  if (state.loading) {
    return (
      <div className="spatial-loading">
        <PageLoader />
      </div>
    );
  }

  if (state.error) {
    return (
      <div className="spatial-error" role="alert">
        Could not load this module: {state.error}
      </div>
    );
  }

  return <Content data={state.data ?? {}} embedded />;
}
