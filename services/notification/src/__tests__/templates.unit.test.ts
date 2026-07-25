import { describe, it, expect } from "vitest";
import { renderTemplate } from "../templates";
import { ORDER_CONFIRMED, ORDER_PLACED, ORDER_CANCELLED } from "@ecom/contracts";

describe("renderTemplate", () => {
  it("renders a distinct subject+html per order event type, embedding orderId", () => {
    const subjects = new Set<string>();
    for (const type of [ORDER_PLACED, ORDER_CONFIRMED, ORDER_CANCELLED]) {
      const r = renderTemplate(type, { orderId: "o123" });
      expect(r.subject).toContain("o123");
      expect(r.html).toContain("o123");
      expect(r.subject.length).toBeGreaterThan(0);
      subjects.add(r.subject);
    }
    expect(subjects.size).toBe(3); // no two events share a subject
  });

  it("throws on an unknown type", () => {
    expect(() => renderTemplate("nope", { orderId: "o1" })).toThrow();
  });
});
