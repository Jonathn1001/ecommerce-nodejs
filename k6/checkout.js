import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

const BASE = __ENV.BASE_URL || "http://localhost:8000";
const PRODUCT_ID = __ENV.PRODUCT_ID;
const POLL_MS = 250; // stated, not incidental — see the saga_duration threshold below

// The saga's duration lives in relay polls and broker hops, none of which appear
// in any single HTTP call, so http_req_duration cannot measure it.
const sagaDuration = new Trend("saga_duration", true);

export const options = {
  vus: Number(__ENV.VUS || 5),
  duration: __ENV.DURATION || "1m",
  // p(99) is not in k6's default summary, and it is the number the saga_duration
  // threshold is written against and that the Prometheus cross-check compares to.
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
  thresholds: {
    http_req_duration: ["p(95)<500"],
    saga_duration: ["p(99)<5000"],
    http_req_failed: ["rate<0.01"],
  },
};

// The gateway rate-limits by client IP: 10/min on the auth routes and 300/min on
// everything (services/gateway/src/app.ts:97-103), both hardcoded. One checkout
// iteration spends two auth calls, two mutations and up to 120 status polls, so a
// single-client run would be almost entirely 429s and every threshold above would be
// measuring rejection latency instead of the saga.
//
// `app.set("trust proxy", 1)` is there precisely so each client behind a terminator
// gets its own bucket, so each iteration presents itself as a distinct client. That is
// what a load test arriving from many machines would look like; it is not a way around
// the limit, and it is recorded in k6/README.md because the SLO numbers are only
// comparable to other runs measured the same way.
function clientIp() {
  const n = __VU * 1000000 + __ITER;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
}

export function setup() {
  if (!PRODUCT_ID)
    throw new Error(
      "PRODUCT_ID is required — seed inventory stock first, see k6/README.md"
    );
  // Fail fast on missing stock. Without this the run "succeeds" with every order
  // CANCELLED for insufficient inventory, and reports a business failure as though
  // it were a latency result — a green threshold on a run that tested nothing.
  const probe = http.get(`${BASE}/products/${PRODUCT_ID}`, {
    headers: { "X-Forwarded-For": "10.255.255.255" },
  });
  if (probe.status !== 200)
    throw new Error(
      `PRODUCT_ID ${PRODUCT_ID} not resolvable via the gateway (status ${probe.status})`
    );
  return {};
}

function csrfFrom(jar) {
  const c = jar.cookiesForURL(BASE);
  return c["XSRF-TOKEN"] ? c["XSRF-TOKEN"][0] : "";
}

export default function () {
  const jar = http.cookieJar();
  const ip = clientIp();
  const email = `k6-${__VU}-${__ITER}-${Date.now()}@example.test`;
  const json = { "Content-Type": "application/json", "X-Forwarded-For": ip };

  // register requires `name` — not just email+password.
  http.post(
    `${BASE}/auth/register`,
    JSON.stringify({ email, password: "password123", name: "k6" }),
    { headers: json }
  );
  http.post(`${BASE}/auth/login`, JSON.stringify({ email, password: "password123" }), {
    headers: json,
  });

  // Every mutation needs the double-submit CSRF header: the readable XSRF-TOKEN cookie
  // echoed back in x-csrf-token (services/gateway/src/csrf.ts).
  const mut = { ...json, "x-csrf-token": csrfFrom(jar) };

  // The cart is its own gateway mount — /cart, not /orders/cart.
  http.post(
    `${BASE}/cart/items`,
    JSON.stringify({ productId: PRODUCT_ID, quantity: 1 }),
    { headers: mut }
  );

  const placed = http.post(`${BASE}/orders`, JSON.stringify({}), { headers: mut });
  if (!check(placed, { "order placed": (r) => r.status === 201 || r.status === 200 }))
    return;

  const orderId = placed.json("orderId");
  const started = Date.now();
  for (;;) {
    const r = http.get(`${BASE}/orders/${orderId}`, { headers: json });
    const status = r.json("status");
    if (status === "CONFIRMED" || status === "CANCELLED") {
      sagaDuration.add(Date.now() - started);
      break;
    }
    if (Date.now() - started > 30000) break; // give up; the threshold will show it
    sleep(POLL_MS / 1000);
  }
}
