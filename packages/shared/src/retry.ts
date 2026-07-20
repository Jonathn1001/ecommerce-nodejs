export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { retries?: number; baseMs?: number; label?: string } = {}
): Promise<T> {
  const { retries = 5, baseMs = 200 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt === retries) break;
      const backoff = baseMs * 2 ** attempt;
      const jitter = Math.random() * backoff * 0.2;
      await new Promise((r) => setTimeout(r, backoff + jitter));
    }
  }
  throw lastErr;
}
