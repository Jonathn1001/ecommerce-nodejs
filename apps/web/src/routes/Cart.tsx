import { useQuery } from "@tanstack/react-query";
import { listProducts } from "../api/products";
import { removeItem, setQuantity } from "../api/cart";
import { useInvalidateSession, useSession } from "../hooks/useSession";
import { EmptyState } from "../components/EmptyState";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Skeleton } from "../components/Skeleton";

export function Cart() {
  const invalidate = useInvalidateSession();
  const session = useSession();
  const products = useQuery({ queryKey: ["products"], queryFn: listProducts });

  if (session.isPending || products.isPending) return <Skeleton />;
  if (session.error) return <ErrorState error={session.error} />;

  const items = session.data?.cart?.items ?? [];
  if (items.length === 0) return <EmptyState message="Your cart is empty." />;

  // The cart carries ids and quantities only, so names and prices come from the catalogue the
  // storefront already caches. A product deleted since it was added degrades to its id.
  const byId = new Map((products.data ?? []).map((p) => [p.id, p]));
  const estimate = items.reduce(
    (sum, i) => sum + (byId.get(i.productId)?.price ?? 0) * i.quantity,
    0
  );

  async function change(productId: string, quantity: number) {
    if (quantity <= 0) await removeItem(productId);
    else await setQuantity(productId, quantity);
    await invalidate();
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
      <p className="flex items-center justify-between">
        <span className="datum text-xs uppercase text-[color:var(--color-muted)]">
          Estimate — the price charged is set when you place the order
        </span>
        <Price minorUnits={estimate} />
      </p>
    </div>
  );
}
