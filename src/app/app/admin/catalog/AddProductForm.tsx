"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { addProduct, type CatalogState } from "./actions";
import { FormField } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" loading={pending} aria-label="Add product">
      {pending ? "Adding…" : "Add product"}
    </Button>
  );
}

export function AddProductForm() {
  const [state, action] = useFormState<CatalogState, FormData>(addProduct, {});
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state.ok) ref.current?.reset();
  }, [state.ok]);

  return (
    <form ref={ref} action={action} className="stack gap-2">
      {state.error && <div className="notice err">{state.error}</div>}
      {state.ok && <div className="notice ok">{state.ok}</div>}
      <div className="grid cols-4">
        <div style={{ gridColumn: "span 2", minWidth: 0 }}>
          <FormField label="Product / service" name="name" placeholder="e.g. Steel gate — standard" required />
        </div>
        <FormField label="SKU (optional)" name="sku" placeholder="SKU-001" />
        <FormField
          label="Unit price"
          name="unit_price"
          inputMode="decimal"
          placeholder="blank = varies"
        />
      </div>
      <div className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
        <div style={{ width: "100%", maxWidth: 120 }}>
          <FormField
            label="Currency"
            name="currency"
            defaultValue="LKR"
            maxLength={3}
          />
        </div>
        <Submit />
      </div>
    </form>
  );
}
