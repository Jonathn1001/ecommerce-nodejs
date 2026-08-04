import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { listProducts } from "../api/products";
import { removeItem, setQuantity } from "../api/cart";
import { describeCheckoutFailure, placeOrder } from "../api/orders";
import { HttpError, UnauthenticatedError } from "../api/errors";
import { useInvalidateSession, useSession } from "../hooks/useSession";
import { Button } from "../components/Button";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

export function Cart() {
  const invalidate = useInvalidateSession();
  const session = useSession();
  const products = useQuery({ queryKey: ["products"], queryFn: listProducts });
  const navigate = useNavigate();
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  if (session.isPending || products.isPending) return <Skeleton />;
  if (session.error) return <ErrorState error={session.error} />;

  const items = session.data?.cart?.items ?? [];
  if (items.length === 0) return <EmptyState message="Your cart is empty." />;

  // The cart carries ids and quantities only, so names and prices come from the catalogue the
  // storefront already caches. A product deleted since it was added degrades to its id.
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
  // If the catalogue query itself failed, byId is empty and every line already degrades to its
  // id — fine, that fallback exists for a single missing product. But summing over an empty
  // map reads as an authoritative $0.00, which is wrong, not a degraded display. Gate the
  // estimate on the catalogue query rather than the whole page: the lines, steppers and
  // checkout still work without it.
  const estimate = products.error
    ? 0
    : items.reduce((sum, i) => sum + (byId.get(i.productId)?.price ?? 0) * i.quantity, 0);

  async function change(productId: string, quantity: number) {
    try {
      if (quantity <= 0) await removeItem(productId);
      else await setQuantity(productId, quantity);
      await invalidate();
    } catch (e) {
      // The cached session said authenticated, but the refresh token died mid-session and
      // request() gave up after its one retry. This page is inside RequireAuth, so
      // invalidating the session query is enough — the guard redirects on its own once the
      // probe comes back unauthenticated.
      if (e instanceof UnauthenticatedError) {
        await invalidate();
        return;
      }
      throw e;
    }
  }

  async function checkout() {
    setCheckoutError(null);
    try {
      const placed = await placeOrder();
      // POST /orders clears the cart inside the same transaction that writes the order, so
      // the badge is stale the moment this returns.
      await invalidate();
      navigate(`/orders/${placed.orderId}`);
    } catch (e) {
      if (e instanceof UnauthenticatedError) {
        // Same dead-session case as change(): invalidate and let RequireAuth redirect. A
        // retry-shaped message here ("could not place the order") would be a lie — the next
        // click can never succeed until the user signs in again.
        await invalidate();
        return;
      }
      if (e instanceof HttpError && e.status === 400) {
        // The cart is already empty server-side. Invalidate BEFORE setting the message so the
        // refetch lands on the real EmptyState instead of stale lines and a live "Place order"
        // button rendering above an alert that contradicts them.
        await invalidate();
        setCheckoutError(describeCheckoutFailure(e));
        return;
      }
      setCheckoutError(describeCheckoutFailure(e));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-2xl">Cart</h1>
      <ul className="flex flex-col gap-3">
        {items.map((i) => {
          const p = byId.get(i.productId);
          return (
            <li
              key={i.productId}
              className="flex items-center justify-between border-b border-[color:var(--color-line)] py-3"
            >
              <span>{p?.name ?? i.productId}</span>
              <span className="flex items-center gap-3">
                {p ? <Price minorUnits={p.price * i.quantity} /> : null}
                <button
                  aria-label={`decrease ${p?.name ?? i.productId}`}
                  onClick={() => void change(i.productId, i.quantity - 1)}
                  className="datum rounded-sm border border-[color:var(--color-line)] px-2"
                >
                  −
                </button>
                <span className="datum">{i.quantity}</span>
                <button
                  aria-label={`increase ${p?.name ?? i.productId}`}
                  onClick={() => void change(i.productId, i.quantity + 1)}
                  className="datum rounded-sm border border-[color:var(--color-line)] px-2"
                >
                  +
                </button>
              </span>
            </li>
          );
        })}
      </ul>
      {products.error ? (
        <p className="datum text-xs text-[color:var(--color-muted)]">
          Estimate unavailable — the catalogue could not be loaded.
        </p>
      ) : (
        <p className="flex items-center justify-between">
          <span className="datum text-xs uppercase text-[color:var(--color-muted)]">
            Estimate — the price charged is set when you place the order
          </span>
          <Price minorUnits={estimate} />
        </p>
      )}
      {checkoutError ? (
        <p role="alert" className="text-sm text-[color:var(--color-fail)]">
          {checkoutError}
        </p>
      ) : null}
      <Button onClick={() => void checkout()}>Place order</Button>
    </div>
  );
}
