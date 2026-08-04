"use client";

import { useEffect, useRef } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { addProduct, type CatalogState } from "./actions";

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button className="btn" type="submit" disabled={pending}>
      {pending ? "Adding…" : "Add product"}
    </button>
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
        <div className="field" style={{ gridColumn: "span 2" }}>
          <label className="label">Product / service</label>
          <input name="name" className="input" placeholder="e.g. Steel gate — standard" required />
        </div>
        <div className="field">
          <label className="label">SKU (optional)</label>
          <input name="sku" className="input" placeholder="SKU-001" />
        </div>
        <div className="field">
          <label className="label">Unit price</label>
          <input name="unit_price" className="input" inputMode="decimal" placeholder="blank = varies" />
        </div>
      </div>
      <div className="row gap-2">
        <div className="field" style={{ width: 120 }}>
          <label className="label">Currency</label>
          <input name="currency" className="input" defaultValue="LKR" maxLength={3} />
        </div>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <Submit />
        </div>
      </div>
    </form>
  );
}
