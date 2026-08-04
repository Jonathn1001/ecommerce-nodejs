import { test, expect } from "@playwright/test";
import { addSeededProductToCart, DECLINING_PRICE, seedProduct } from "./fixtures";

// The compensation path is the half of the saga that a happy-path demo never shows: payment
// declines, Order cancels, Inventory releases the reservation. The tracker has to say so.
test("a declined payment shows the compensation path", async ({ page }) => {
  const productId = await seedProduct(DECLINING_PRICE, "e2e-decline");
  await addSeededProductToCart(page, productId);

  await page.goto("/cart");
  await page.getByRole("button", { name: /place order/i }).click();
  await expect(page).toHaveURL(/\/orders\/[\w-]+/);

  // `exact` because the polite live region also says "Order cancelled — Payment failed", and a
  // substring match would resolve to both it and the badge.
  await expect(page.getByText("CANCELLED", { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // Observed live, so the tracker knows WHICH leg failed: the reservation succeeded (the order
  // reached AWAITING_PAYMENT) and the charge did not.
  // Substring, not an anchored pattern: each step's text starts with its glyph, so ^Payment
  // matches nothing. "Payment" appears in exactly one of the four step labels.
  const paymentStep = page.getByRole("listitem").filter({ hasText: "Payment" });
  await expect(paymentStep).toContainText(/failed/i);
});
