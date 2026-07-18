import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "services/**/*.test.ts"],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
