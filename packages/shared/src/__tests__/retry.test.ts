import { describe, it, expect } from "vitest";
import { withRetry } from "../retry";

describe("withRetry", () => {
  it("resolves after transient failures", async () => {
    let n = 0;
    const out = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new Error("transient");
        return "ok";
      },
      { retries: 5, baseMs: 1 }
    );
    expect(out).toBe("ok");
    expect(n).toBe(3);
  });

  it("rethrows after exhausting retries", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new Error("always");
        },
        { retries: 2, baseMs: 1 }
      )
    ).rejects.toThrow("always");
    expect(n).toBe(3); // initial + 2 retries
  });
});
