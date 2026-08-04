import { expect, type Page } from "@playwright/test";

// Written by the setup project, read by every walk. Gitignored: it holds a live session.
export const STORAGE_STATE = "e2e/.auth/user.json";

// Catalog and Inventory are addressed DIRECTLY, not through the gateway. Creating a product is
// an ADMIN-granted mutation and Inventory is not mounted on the gateway at all, so a fixture
// that went through the front door would need an admin session the storefront never has. These
// are dev-published ports; nothing in the app knows they exist.
const CATALOG = process.env.CATALOG_URL ?? "http://localhost:3004";
const INVENTORY = process.env.INVENTORY_URL ?? "http://localhost:3001";

// Payment declines when the charged minor units satisfy % 100 === 1 and parks in PROCESSING
// when they satisfy % 100 === 99 (services/payment/src/charge.ts). The storefront cannot pick
// an amount — the total comes from catalog prices through Order's read model — so a walk that
// needs a decline has to create a product priced to land there. 99 is avoided deliberately:
// that is the async webhook path, which never settles on its own.
export const DECLINING_PRICE = 1301;
export const SETTLING_PRICE = 1300;

export async function seedProduct(price: number, tag: string): Promise<string> {
  const res = await fetch(`${CATALOG}/products`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "ELECTRONICS",
      name: `${tag}-${Date.now()}`,
      price,
      attributes: { manufacturer: "e2e", model: tag },
    }),
  });
  if (!res.ok) throw new Error(`product create failed: ${res.status}`);
  const { productId } = (await res.json()) as { productId: string };

  // Without stock the saga cancels at the reservation leg, so every walk would take the
  // compensation path and the confirming one would fail for the wrong reason.
  const stock = await fetch(`${INVENTORY}/inventory/stock`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ productId, quantity: 50 }),
  });
  if (!stock.ok) throw new Error(`stock seed failed: ${stock.status}`);

  return productId;
}

export async function addSeededProductToCart(
  page: Page,
  productId: string
): Promise<void> {
  await page.goto(`/products/${productId}`);
  await page.getByRole("button", { name: /add to cart/i }).click();
  await expect(page.getByRole("link", { name: /cart \(/i })).toContainText("1");
}
