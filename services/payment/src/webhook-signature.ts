import { createHmac, timingSafeEqual } from "crypto";

// HMAC-SHA256 over the RAW body. Re-serialising a parsed body would not reproduce the
// provider's bytes, and `===` on a MAC leaks its prefix through timing.
export function verifyWebhookSignature(
  raw: Buffer | string,
  header: string | undefined,
  secret: string
): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const provided = Buffer.from(header.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", secret).update(raw).digest();
  if (provided.length !== expected.length) return false; // timingSafeEqual throws otherwise
  return timingSafeEqual(provided, expected);
}
