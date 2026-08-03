export function Badge({ children }: { children: string }) {
  return (
    <span className="datum rounded-full border border-[color:var(--color-line-strong)] bg-[color:var(--color-surface)] px-2 py-0.5 text-[10.5px] uppercase tracking-[0.12em] text-[color:var(--color-muted)]">
      {children}
    </span>
  );
}
