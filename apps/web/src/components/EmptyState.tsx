export function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-md border border-dashed border-[color:var(--color-line-strong)] p-12 text-center text-[color:var(--color-muted)]">
      {message}
    </p>
  );
}
