import { HttpError, NetworkError, SchemaMismatchError } from "../api/errors";
import { Button } from "./Button";

// A schema mismatch is backend drift, not a user condition — it says so plainly rather than
// rendering as "something went wrong", which is how a contract violation gets mistaken for an
// empty catalogue.
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message =
    error instanceof NetworkError
      ? "Could not reach the store. Check your connection."
      : error instanceof SchemaMismatchError
        ? "The store sent data this page does not understand. This is a bug, not you."
        : error instanceof HttpError
          ? `The store answered ${error.status}.`
          : "Something went wrong.";

  return (
    <div role="alert" className="p-12 text-center">
      <p className="text-[color:var(--color-muted)]">{message}</p>
      {error instanceof NetworkError && onRetry ? (
        <div className="mt-4">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
    </div>
  );
}
