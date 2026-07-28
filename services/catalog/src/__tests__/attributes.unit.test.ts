import { describe, it, expect } from "vitest";
import { validateAttributes } from "../attributes";

const GOLDEN = {
  ELECTRONICS: { manufacturer: "Acme", model: "X1", color: "black" },
  CLOTHING: { brand: "Acme", size: "M", material: "cotton", color: "blue" },
  FURNITURE: { brand: "Acme", size: "L", material: "oak" },
  MOTORBIKE: { manufacturer: "Acme", model: "R1", color: "red" },
} as const;

describe("validateAttributes (golden from legacy factory)", () => {
  for (const [type, attrs] of Object.entries(GOLDEN)) {
    it(`accepts a valid ${type} sample`, () => {
      const r = validateAttributes(type, attrs);
      expect(r.ok).toBe(true);
    });
  }
  it("rejects a missing required field (ELECTRONICS.manufacturer)", () => {
    expect(validateAttributes("ELECTRONICS", { model: "X1" }).ok).toBe(false);
  });
  it("rejects an unknown type", () => {
    expect(validateAttributes("SPACESHIP", {}).ok).toBe(false);
  });
  it("accepts only the required field (optionals omitted)", () => {
    expect(validateAttributes("CLOTHING", { brand: "Acme" }).ok).toBe(true);
  });
});
