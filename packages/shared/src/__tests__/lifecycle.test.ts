import { describe, it, expect } from "vitest";
import { runClosers } from "../lifecycle";

describe("runClosers", () => {
  it("runs closers in reverse order", async () => {
    const order: number[] = [];
    await runClosers(
      [
        async () => void order.push(1),
        async () => void order.push(2),
        async () => void order.push(3),
      ],
      1000
    );
    expect(order).toEqual([3, 2, 1]);
  });

  it("rejects when a closer hangs past the timeout", async () => {
    await expect(runClosers([() => new Promise(() => {})], 50)).rejects.toThrow(
      /timeout/
    );
  });
});
