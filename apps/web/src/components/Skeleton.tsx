// Matches the card geometry rather than being a spinner, so the grid does not reflow when
// data lands.
export function Skeleton() {
  return (
    <div
      data-testid="skeleton"
      className="h-64 animate-pulse rounded-lg bg-[color:var(--color-surface-2)]"
    />
  );
}
