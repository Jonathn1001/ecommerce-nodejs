import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useParams } from "react-router";
import { HttpError, UnauthenticatedError } from "../api/errors";
import { getProduct } from "../api/products";
import { addItem } from "../api/cart";
import { Badge } from "../components/Badge";
import { Button } from "../components/Button";
import { ErrorState } from "../components/ErrorState";
import { Price } from "../components/Price";
import { Silhouette } from "../components/Silhouette";
import { Skeleton } from "../components/Skeleton";
import { useInvalidateSession, useSession } from "../hooks/useSession";

// attributes values are `unknown` by contract. Render primitives; skip everything else rather
// than emitting "[object Object]". Values are API-sourced strings, so they go through React's
// normal escaping — never dangerouslySetInnerHTML.
function primitiveEntries(attributes: Record<string, unknown>) {
  return Object.entries(attributes).filter(
    ([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  ) as [string, string | number | boolean][];
}

export function Product() {
  const { id = "" } = useParams();
  const { data, error, isPending, refetch } = useQuery({
    queryKey: ["product", id],
    queryFn: () => getProduct(id),
  });
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const invalidate = useInvalidateSession();

  // The cart is keyed by userId server-side — there is no anonymous cart to fill. Send the
  // visitor to sign in and bring them back here, rather than hiding the button and making the
  // catalogue read as a brochure.
  async function add(productId: string) {
    if (!session.data?.authenticated) {
      navigate("/login", { state: { from: location.pathname } });
      return;
    }
    try {
      await addItem(productId, 1);
      await invalidate();
    } catch (e) {
      // The cached session said authenticated, but the refresh token died in between (mid
      // session, not on this click) and request() gave up after its one retry. Catch up with
      // the server's decision instead of letting the click land as an unhandled rejection.
      if (e instanceof UnauthenticatedError) {
        await invalidate();
        navigate("/login", { state: { from: location.pathname } });
        return;
      }
      throw e;
    }
  }

  if (isPending) return <Skeleton />;

  if (error instanceof HttpError && error.status === 404) {
    return (
      <div className="p-12 text-center">
        <h1 className="text-2xl">Product not found</h1>
        <p className="mt-2 text-[color:var(--color-muted)]">
          It may have been removed since you last looked.
        </p>
        <Link to="/" className="datum mt-4 inline-block underline">
          Back to the catalogue
        </Link>
      </div>
    );
  }
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <div className="flex aspect-[4/3] items-center justify-center rounded-lg border border-[color:var(--color-line)] bg-[color:var(--color-surface-2)]">
        <Silhouette type={data.type} />
      </div>
      <div className="flex flex-col gap-4">
        <Badge>{data.type}</Badge>
        <h1 className="text-3xl">{data.name}</h1>
        <Price minorUnits={data.price} />
        <div>
          {/* A fast click on a cold load must not read a still-loading probe as anonymous. */}
          <Button disabled={session.isPending} onClick={() => void add(data.id)}>
            Add to cart
          </Button>
        </div>
        <dl className="border-t border-[color:var(--color-line)]">
          {primitiveEntries(data.attributes).map(([k, v]) => (
            <div
              key={k}
              className="flex justify-between border-b border-[color:var(--color-line)] py-2"
            >
              <dt className="datum text-xs uppercase text-[color:var(--color-muted)]">
                {k}
              </dt>
              <dd className="datum">{String(v)}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
