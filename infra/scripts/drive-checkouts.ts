// Places N orders against the gateway at a controlled rate. Separate from k6 because
// chaos needs a steady trickle while the script does other things, not a load profile.
const BASE = process.env.BASE_URL ?? "http://localhost:8000";
const COUNT = Number(process.env.COUNT ?? 20);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 500);
const PRODUCT_ID = process.env.PRODUCT_ID;

if (!PRODUCT_ID) throw new Error("PRODUCT_ID required — seed inventory stock first");

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}
function absorb(jar: Map<string, string>, res: Response): void {
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";");
    const i = pair.indexOf("=");
    jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}

// The gateway rate-limits per client IP — 10/min on the auth routes, 300/min on
// everything (services/gateway/src/app.ts:97-103), both hardcoded — and buckets by the
// forwarded address because `app.set("trust proxy", 1)`. A sustained driver from one
// apparent client starts collecting 429s, and during an alert-validation run that is
// actively harmful: a rate-limited request never reaches the broken service, so it
// produces no 5xx and quietly flattens the very error rate the run exists to measure.
// Each iteration therefore presents a distinct address, same rationale as k6/checkout.js.
const clientIp = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

async function main() {
  const jar = new Map<string, string>();
  const email = `chaos-${Date.now()}@example.test`;
  const json = { "content-type": "application/json" };
  // Registration and login are one client; only the per-order traffic rotates, so the
  // session cookies stay valid for the whole run.
  const authIp = clientIp(0);

  // register requires `name`, not just email+password.
  await fetch(`${BASE}/auth/register`, {
    method: "POST",
    headers: { ...json, "x-forwarded-for": authIp },
    body: JSON.stringify({ email, password: "password123", name: "chaos" }),
  });
  absorb(
    jar,
    await fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { ...json, "x-forwarded-for": authIp },
      body: JSON.stringify({ email, password: "password123" }),
    })
  );

  // Double-submit CSRF: echo the XSRF-TOKEN cookie into the header.
  const mut = (ip: string) => ({
    ...json,
    cookie: cookieHeader(jar),
    "x-csrf-token": jar.get("XSRF-TOKEN") ?? "",
    "x-forwarded-for": ip,
  });

  for (let i = 0; i < COUNT; i++) {
    const ip = clientIp(i + 1);
    try {
      // The cart is its own gateway mount — /cart, not /orders/cart.
      await fetch(`${BASE}/cart/items`, {
        method: "POST",
        headers: mut(ip),
        body: JSON.stringify({ productId: PRODUCT_ID, quantity: 1 }),
      });
      const r = await fetch(`${BASE}/orders`, {
        method: "POST",
        headers: mut(ip),
        body: "{}",
      });
      // Errors are EXPECTED mid-outage and must not stop the driver — an error rate
      // needs a denominator, and a driver that quits on the first 5xx flattens it.
      console.log(`${i} ${r.status}`);
    } catch (e) {
      console.log(`${i} ERR ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

void main();
