import type { ReactNode } from "react";
import "./globals.css";
import LivingBackground from "@/components/LivingBackground";

export const metadata = {
  title: "Singha Central",
  description:
    "Sign in to your own work — finance, operations, people, procurement, compliance, fleet and sales in one place. What is yours to decide reaches you; every decision is recorded.",
};

export const viewport = {
  themeColor: "#0b0e11",
  width: "device-width",
  initialScale: 1,
  // Let content extend under notches; globals.css pads with safe-area insets.
  viewportFit: "cover" as const,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <LivingBackground />
        {children}
      </body>
    </html>
  );
}
