import { createApp } from "./app";
import { config } from "./config";
import { createGrantsCache } from "./grants-cache";
import { createLogger, gracefulShutdown } from "@ecom/shared";

const log = createLogger("gateway-main");

async function main() {
  const grants = createGrantsCache({
    identityUrl: config.IDENTITY_URL,
    ttlMs: config.GRANTS_TTL_MS,
  });
  // Fail fast: serving with an empty matrix would 403 every admin route while looking
  // healthy. A LATER refresh failure keeps the last good snapshot instead (grants-cache.ts).
  await grants.refresh();

  const app = createApp({
    publicKey: config.JWT_PUBLIC_KEY,
    upstreams: {
      identity: config.IDENTITY_URL,
      order: config.ORDER_URL,
      catalog: config.CATALOG_URL,
      payment: config.PAYMENT_URL,
    },
    grants,
    cookieSecure: config.COOKIE_SECURE,
    breaker: { timeoutMs: config.BREAKER_TIMEOUT_MS, resetMs: config.BREAKER_RESET_MS },
  });

  const server = app.listen(config.PORT, () =>
    log.info("gateway_listening", { port: config.PORT })
  );

  gracefulShutdown([
    async () => {
      grants.stop();
    },
    async () => {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
    },
  ]);
}

main().catch((e) => {
  log.error("gateway_fatal", { message: (e as Error).message });
  process.exit(1);
});
