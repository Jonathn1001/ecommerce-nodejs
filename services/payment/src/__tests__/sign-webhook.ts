import { createHmac } from "crypto";
import { config } from "../config";

// Shared signer for int/e2e tests that call POST /webhooks/payment. Signs with the
// service's own loaded PAYMENT_WEBHOOK_SECRET (not a hardcoded duplicate) so a valid
// header always matches whatever secret the app under test is actually verifying
// against. Must sign the EXACT bytes supertest puts on the wire: JSON.stringify(body),
// same as superagent's own json serialization of `.send(body)`.
export function signWebhookBody(body: object): string {
  const raw = JSON.stringify(body);
  return `sha256=${createHmac("sha256", config.PAYMENT_WEBHOOK_SECRET).update(raw).digest("hex")}`;
}
