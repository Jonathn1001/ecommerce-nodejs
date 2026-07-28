import { describe, it, expect, vi } from "vitest";
import { makeRabbitLifecycle } from "../rabbitmq";

describe("makeRabbitLifecycle", () => {
  it("an UNEXPECTED close calls onLost (the process must die so the restart policy re-boots it)", () => {
    const onLost = vi.fn();
    const lc = makeRabbitLifecycle(onLost);
    lc.onClose();
    expect(onLost).toHaveBeenCalledTimes(1);
    expect(lc.isHealthy()).toBe(false);
  });

  it("a close we initiated does NOT call onLost (graceful shutdown must not self-kill)", () => {
    const onLost = vi.fn();
    const lc = makeRabbitLifecycle(onLost);
    lc.markClosing();
    lc.onClose();
    expect(onLost).not.toHaveBeenCalled();
  });

  it("an error marks unhealthy without killing — the close event that follows decides", () => {
    const onLost = vi.fn();
    const lc = makeRabbitLifecycle(onLost);
    lc.onError();
    expect(lc.isHealthy()).toBe(false);
    expect(onLost).not.toHaveBeenCalled();
  });

  it("fires onLost at most once even if close repeats", () => {
    const onLost = vi.fn();
    const lc = makeRabbitLifecycle(onLost);
    lc.onClose();
    lc.onClose();
    expect(onLost).toHaveBeenCalledTimes(1);
  });
});
