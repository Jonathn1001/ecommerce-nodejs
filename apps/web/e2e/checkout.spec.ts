import { test, expect } from "@playwright/test";
import { addSeededProductToCart, seedProduct, SETTLING_PRICE } from "./fixtures";

test("browse to checkout, and the pipeline confirms without a reload", async ({
  page,
}) => {
  const productId = await seedProduct(SETTLING_PRICE, "e2e-settle");
  await addSeededProductToCart(page, productId);

  // Reaching CONFIRMED is not by itself proof of liveness — the ladder's polling fallback would
  // get there too, just slower, and a suite that cannot tell them apart would go green over a
  // completely dead stream. Count both transports and assert which one did the work.
  let streams = 0;
  let orderGets = 0;
  page.on("request", (r) => {
    if (/\/api\/orders\/[\w-]+\/stream$/.test(r.url())) streams += 1;
    else if (/\/api\/orders\/[\w-]+$/.test(r.url())) orderGets += 1;
  });

  await page.goto("/cart");
  await page.getByRole("button", { name: /place order/i }).click();

  // The order page is reached by the checkout itself, and from here on NOTHING reloads: every
  // assertion below has to be satisfied by frames arriving over the stream. That is the whole
  // point of the walk — a green jsdom suite proved liveness in 8a and 7c and was wrong twice.
  await expect(page).toHaveURL(/\/orders\/[\w-]+/);
  await expect(page.getByText("Order placed")).toBeVisible();

  await expect(page.getByText("CONFIRMED", { exact: true })).toBeVisible({
    timeout: 60_000,
  });
  // No step is still in flight. Written as an attribute locator on purpose: Playwright's
  // getByRole has no `current` option (Testing Library does), so passing one is silently
  // ignored and the assertion would match every list item on the page.
  await expect(page.locator('li[aria-current="step"]')).toHaveCount(0);

  expect(streams).toBe(1);
  // One GET for the initial load. More than that would mean the query was polling, i.e. the
  // stream had failed and the page reached CONFIRMED the slow way.
  expect(orderGets).toBe(1);
});

test("the order appears in history", async ({ page }) => {
  const productId = await seedProduct(SETTLING_PRICE, "e2e-history");
  await addSeededProductToCart(page, productId);
  await page.goto("/cart");
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page).toHaveURL(/\/orders\/[\w-]+/);
  const orderId = page.url().split("/").pop()!;

  await page.getByRole("link", { name: /^orders$/i }).click();
  await expect(page.getByRole("link", { name: new RegExp(orderId) })).toBeVisible();
});
