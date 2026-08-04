import { test as setup, expect } from "@playwright/test";
import { STORAGE_STATE } from "./fixtures";

// One account for the whole run, saved as storage state.
//
// The gateway rate-limits /auth/* to 10 requests a minute per apparent client and buckets by
// the forwarded address (services/gateway/src/app.ts). A browser cannot rotate x-forwarded-for
// the way infra/scripts/drive-checkouts.ts does, so a suite that registered and signed in per
// walk would spend its whole budget on authentication and then fail with 429s that read as
// application bugs. Registering once costs two.
setup("register and sign in once", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.test`;

  await page.goto("/register");
  await page.getByLabel(/name/i).fill("E2E");
  await page.getByLabel(/email/i).fill(email);
  await page.getByLabel(/password/i).fill("password123");
  await page.getByRole("button", { name: /create account/i }).click();

  // Registering does not sign you in (8b §B3): it lands on the login form, email prefilled.
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel(/password/i).fill("password123");
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("link", { name: /^orders$/i })).toBeVisible();

  await page.context().storageState({ path: STORAGE_STATE });
});
