import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Singha — Business Control",
  description: "Singha AI business control system: orders, quotations, finance & departments.",
};

export const viewport = {
  themeColor: "#1a0524",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
