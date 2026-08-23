import type { MetadataRoute } from "next";

export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Singha Central",
    short_name: "Singha",
    description:
      "Sign in to your own work — finance, operations, people, procurement, compliance, fleet and sales in one place.",
    start_url: "/app",
    display: "standalone",
    background_color: "#0b0e11",
    theme_color: "#0b0e11",
    orientation: "portrait-primary",
    icons: [
      {
        src: "/brand/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/brand/lion.png",
        sizes: "366x375",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
