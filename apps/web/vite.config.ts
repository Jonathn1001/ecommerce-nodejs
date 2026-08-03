import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The browser never addresses the gateway directly. Every API prefix is proxied so the app
// is same-origin: no CORS on the gateway, and 8b's cookies work on SameSite=Lax.
const GATEWAY = process.env.GATEWAY_URL ?? "http://localhost:8000";
const API_PREFIXES = ["/products", "/cart", "/orders", "/auth"];

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      API_PREFIXES.map((p) => [p, { target: GATEWAY, changeOrigin: true }])
    ),
  },
});
