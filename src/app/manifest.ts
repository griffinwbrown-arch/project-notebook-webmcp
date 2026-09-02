import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Project Notebook",
    short_name: "Notebook",
    description: "A private Project: Notebook playground with direct WebMCP page and anatomy tools.",
    start_url: "/desk",
    display: "standalone",
    background_color: "#efe8dc",
    theme_color: "#1c1c1b",
    icons: [
      {
        src: "/favicon.ico",
        sizes: "any",
        type: "image/x-icon",
      },
    ],
  };
}
