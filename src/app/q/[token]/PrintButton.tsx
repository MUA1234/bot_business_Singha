"use client";
import { Printer } from "lucide-react";
export function PrintButton() {
  return (
    <button className="qbtn" onClick={() => window.print()} type="button" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
      <Printer size={16} /> Print / Save as PDF
    </button>
  );
}
