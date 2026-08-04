"use client";
export function PrintButton() {
  return (
    <button className="qbtn" onClick={() => window.print()} type="button">
      🖨 Print / Save as PDF
    </button>
  );
}
