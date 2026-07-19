import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    nodePolyfills({ globals: { Buffer: true, global: true, process: true }, protocolImports: true }),
    VitePWA({
      registerType: "autoUpdate",
      // The Privy + Anchor + web3.js vendor bundle exceeds Workbox's default 2 MiB
      // precache cap; raise it so the service worker generates and precaches it.
      workbox: { maximumFileSizeToCacheInBytes: 4 * 1024 * 1024 },
      manifest: {
        name: "BullStake",
        short_name: "BullStake",
        description: "On-chain parimutuel for World Cup soccer",
        theme_color: "#FF6A1A",
        background_color: "#07090d",
        display: "standalone",
        icons: [
          { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
          { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
    }),
  ],
});
