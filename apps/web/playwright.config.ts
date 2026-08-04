import { defineConfig } from "@playwright/test";

// LOCAL ONLY. CI's quality job has no compose stack, and standing up eight services plus two
// brokers to run three browser walks is its own slice — see the 8c spec §F4, where the absence
// is recorded as a decision rather than a gap.
//
// Prerequisites: `docker compose up -d` (datastores AND the app profile), then either the Vite
// dev server or the nginx image from apps/web/Dockerfile. Point WEB_URL at whichever is up.
export default defineConfig({
  testDir: "./e2e",
  // A walk waits on a real saga: Kafka hop, outbox poll, payment, and back.
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // Serial. The gateway rate-limits /auth/* to 10 requests a minute per apparent client
  // (services/gateway/src/app.ts), and a browser cannot spoof x-forwarded-for the way
  // infra/scripts/drive-checkouts.ts does — parallel walks would collect 429s and read as
  // application failures.
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: process.env.WEB_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    // Authenticates once and saves the state. Every walk starts signed in, so a full run costs
    // two auth requests out of the ten a minute the gateway allows.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "chromium",
      dependencies: ["setup"],
      use: { browserName: "chromium", storageState: "e2e/.auth/user.json" },
      testIgnore: /auth\.setup\.ts/,
    },
  ],
});
