"use client";

import { useState } from "react";
import { threeWayMatch } from "@/modules/procurement/three-way-match";

/**
 * Live three-way-match check (§9.2). The pure engine runs in the browser as finance
 * types the supplier bill's quantity and amount — showing whether the bill matches
 * the PO and what was received, before it's approved for payment.
 */
export function ThreeWayCheck({
  currency,
  poQuantity,
  poAmount,
  receivedQuantity,
}: {
  currency: string;
  poQuantity: number;
  poAmount: string;
  receivedQuantity: number;
}) {
  const [billedQuantity, setBilledQuantity] = useState("");
  const [billedAmount, setBilledAmount] = useState("");

  const cur = (currency || "LKR").trim().toUpperCase().slice(0, 3);
  const safePoAmount = /^-?\d+(\.\d+)?$/.test(String(poAmount)) ? String(poAmount) : "0";
  const bq = Number(billedQuantity);
  const ba = billedAmount.trim();
  const ready = billedQuantity.trim() !== "" && ba !== "" && Number.isFinite(bq) && /^[A-Z]{3}$/.test(cur);

  const result = ready
    ? threeWayMatch({
        currency: cur,
        poQuantity,
        poAmount: safePoAmount,
        receivedQuantity,
        billedQuantity: bq,
        billedAmount: /^-?\d+(\.\d+)?$/.test(ba) ? ba : "0",
        amountTolerancePct: 0.02,
      })
    : null;

  return (
    <div>
      <div className="row gap-1 wrap">
        <input className="input" style={{ width: 150 }} placeholder="Billed qty" inputMode="decimal"
          value={billedQuantity} onChange={(e) => setBilledQuantity(e.target.value)} />
        <input className="input" style={{ width: 170 }} placeholder="Billed amount" inputMode="decimal"
          value={billedAmount} onChange={(e) => setBilledAmount(e.target.value)} />
      </div>
      <div className="mt-2">
        {!result ? (
          <span className="small dim">Enter the supplier bill quantity and amount to check (2% price tolerance).</span>
        ) : result.matched ? (
          <span className="badge ok">✓ Matches — PO, receipt and bill agree</span>
        ) : (
          <div className="stack gap-1">
            <span className="badge danger">Mismatch — do not approve as-is</span>
            {result.issues.map((iss, i) => (
              <span key={i} className="small" style={{ color: "var(--danger)" }}>• {iss}</span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
