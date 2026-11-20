import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";
export default defineConfig({
  base: "./",
  build: {
    rollupOptions: {
      input: { main: "index.html", documentFlow: "document-flow.html" },
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      workbox: {
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
        globPatterns: ["**/*.{js,css,html,svg,webmanifest}"],
        globIgnores: ["ocr/**", "pdf-fonts/**"],
        maximumFileSizeToCacheInBytes: 6000000,
        navigateFallbackDenylist: [/^\/auth\//],
        runtimeCaching: [],
      },
      manifest: {
        name: "SignatureFlow",
        short_name: "SignatureFlow",
        description: "Lire, préparer et signer vos PDF en quelques gestes.",
        theme_color: "#345ce6",
        background_color: "#f3f5f9",
        display: "standalone",
        start_url: "./",
        icons: [
          {
            src: "icon.svg",
            sizes: "any",
            type: "image/svg+xml",
            purpose: "any maskable",
          },
        ],
      },
    }),
  ],
});
