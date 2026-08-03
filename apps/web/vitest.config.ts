// The test config is deliberately separate from vite.config.ts. Vitest 2.1 (the repo pin)
// carries vite 5 types while this app builds on vite 8, so a single config holding both the
// vite-8 plugin array and the `test` block cannot typecheck against either signature. Keeping
// `test` here — with no plugins — also stops vitest's vite 5 from loading vite 8 plugins.
// JSX still transforms: esbuild reads `jsx: "react-jsx"` from tsconfig.json.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
