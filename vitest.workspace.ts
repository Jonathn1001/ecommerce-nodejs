// One `pnpm vitest run` covers every project. The three node projects keep the globs and
// timeouts the root config already used; apps/web needs jsdom, which the node projects must
// not inherit — which is the whole reason this file exists.
import { defineWorkspace } from "vitest/config";

const node = {
  testTimeout: 20_000,
  hookTimeout: 30_000,
};

export default defineWorkspace([
  { test: { ...node, name: "packages", include: ["packages/**/*.test.ts"] } },
  { test: { ...node, name: "services", include: ["services/**/*.test.ts"] } },
  { test: { ...node, name: "infra", include: ["infra/**/*.test.ts"] } },
  "./apps/web",
]);
