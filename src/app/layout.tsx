import type { ReactNode } from "react";
import "./globals.css";
import LivingBackground from "@/components/LivingBackground";

export const metadata = {
  title: "Singha Central",
  description:
    "Run the whole business from one place — finance, operations, people, procurement, compliance, fleet and sales. Your team keeps the work moving, every decision is recorded, and each person sees only their own work.",
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
