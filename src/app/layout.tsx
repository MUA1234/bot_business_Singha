import type { ReactNode } from "react";

export const metadata = {
  title: "AI Finance System — Accounting Core v0",
  description: "Event-driven, multi-company AI finance system (interim).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
