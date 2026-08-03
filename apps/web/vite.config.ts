import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The browser never addresses the gateway directly. The API is proxied so the app is
// same-origin: no CORS on the gateway, and 8b's cookies work on SameSite=Lax.
//
// Everything the gateway serves sits under one /api prefix, stripped on the way through,
// rather than proxying the gateway's own prefixes at the origin root. Rooted, /products would
// be both an API resource and this app's product page — and the proxy wins, so a hard refresh
// or a shared link to a product renders raw JSON instead of the app. 8b makes that worse:
// /cart and /orders are storefront pages too. One namespace keeps the two URL spaces disjoint
// by construction, and 8c's nginx needs one location block instead of a rule per prefix.
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8000";
const API_PREFIX = "/api";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      [API_PREFIX]: {
        target: GATEWAY,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
