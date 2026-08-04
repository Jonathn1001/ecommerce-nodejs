import { test as teardown } from "@playwright/test";
import { Client } from "pg";
import { E2E_TAG } from "./fixtures";

// 7d's rule, applied to the browser suite: a test cleans the dev database it dirtied.
//
// Deleting by QUERY on a tag rather than by a list of ids collected in memory — a suite that
// crashes half way still gets cleaned on the next run, which an id list would not survive.
// The tag lives in the product NAME and in the e2e account EMAIL, both of which every walk
// stamps, so nothing untagged is ever in range of these statements.
const DBS = {
  order: process.env.ORDER_DB_URL ?? "postgres://ecom:ecom@localhost:5432/order",
  catalog: process.env.CATALOG_DB_URL ?? "postgres://ecom:ecom@localhost:5432/catalog",
  inventory:
    process.env.INVENTORY_DB_URL ?? "postgres://ecom:ecom@localhost:5432/inventory",
  identity: process.env.IDENTITY_DB_URL ?? "postgres://ecom:ecom@localhost:5432/identity",
};

async function withDb<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

teardown("remove everything the walks created", async () => {
  // Products first: their ids are what every other table is keyed by.
  const productIds = await withDb(DBS.catalog, async (c) => {
    const found = await c.query<{ id: string }>(
      'SELECT id FROM "Product" WHERE name LIKE $1',
      [`${E2E_TAG}%`]
    );
    const ids = found.rows.map((r) => r.id);
    if (ids.length) {
      // Outbox rows are keyed by aggregateId and do not cascade from Product (no FK).
      await c.query('DELETE FROM "Outbox" WHERE "aggregateId" = ANY($1::text[])', [ids]);
      await c.query('DELETE FROM "Product" WHERE id = ANY($1::text[])', [ids]);
    }
    return ids;
  });

  // Orders that reference those products, plus the carts and outbox rows hanging off them.
  const orderIds = productIds.length
    ? await withDb(DBS.order, async (c) => {
        const found = await c.query<{ orderId: string }>(
          'SELECT DISTINCT "orderId" FROM "OrderItem" WHERE "productId" = ANY($1::text[])',
          [productIds]
        );
        const ids = found.rows.map((r) => r.orderId);
        if (ids.length) {
          await c.query('DELETE FROM "Outbox" WHERE "aggregateId" = ANY($1::text[])', [
            ids,
          ]);
          // OrderItem cascades from Order (onDelete: Cascade in schema.prisma).
          await c.query('DELETE FROM "Order" WHERE id = ANY($1::text[])', [ids]);
        }
        await c.query(
          'DELETE FROM "CatalogReadModel" WHERE "productId" = ANY($1::text[])',
          [productIds]
        );
        return ids;
      })
    : [];

  if (productIds.length) {
    await withDb(DBS.inventory, async (c) => {
      await c.query('DELETE FROM "Reservation" WHERE "productId" = ANY($1::text[])', [
        productIds,
      ]);
      await c.query('DELETE FROM "Inventory" WHERE "productId" = ANY($1::text[])', [
        productIds,
      ]);
      if (orderIds.length)
        await c.query('DELETE FROM "Outbox" WHERE "aggregateId" = ANY($1::text[])', [
          orderIds,
        ]);
    });
  }

  // The throwaway accounts. Refresh tokens cascade from User; the outbox rows do not.
  const users = await withDb(DBS.identity, async (c) => {
    const found = await c.query<{ id: string }>(
      'SELECT id FROM "User" WHERE email LIKE $1',
      [`${E2E_TAG}%`]
    );
    const ids = found.rows.map((r) => r.id);
    if (ids.length) {
      await c.query('DELETE FROM "Outbox" WHERE "aggregateId" = ANY($1::text[])', [ids]);
      await c.query('DELETE FROM "User" WHERE id = ANY($1::text[])', [ids]);
    }
    return ids;
  });

  console.log(
    `e2e cleanup: ${productIds.length} products, ${orderIds.length} orders, ${users.length} accounts`
  );
});
