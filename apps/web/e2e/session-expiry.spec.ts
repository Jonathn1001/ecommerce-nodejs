import { test, expect } from "@playwright/test";
import { addSeededProductToCart, seedProduct, SETTLING_PRICE } from "./fixtures";

// 8b deferred this walk, and 8c is where it belongs: the ladder's first rung exists precisely
// for an access token that dies mid-saga. Dropping only the access cookie leaves the refresh
// cookie in place, which is the real shape of an expiry — the session is recoverable, and the
// page must recover it rather than stranding the user on a tracker that stopped moving.
test("a session expiring mid-saga still reaches a terminal state", async ({
  page,
  context,
}) => {
  const productId = await seedProduct(SETTLING_PRICE, "e2e-expiry");
  await addSeededProductToCart(page, productId);

  await page.goto("/cart");
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page).toHaveURL(/\/orders\/[\w-]+/);

  // Kill the access token while the saga is in flight, keeping the refresh token.
  const kept = (await context.cookies()).filter((c) => c.name !== "access_token");
  await context.clearCookies();
  await context.addCookies(kept);

  await expect(page.getByText(/CONFIRMED|CANCELLED/)).toBeVisible({ timeout: 60_000 });
  // Recovered, not signed out: a redirect to /login would mean the ladder gave up on a session
  // that was still refreshable.
  await expect(page).toHaveURL(/\/orders\/[\w-]+/);
});
