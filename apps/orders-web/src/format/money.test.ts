import { describe, expect, it } from "vitest";
import { formatCents, sumCents } from "./money";

describe("formatCents", () => {
  it("formats whole and fractional amounts", () => {
    expect(formatCents(1250, "USD")).toBe("$12.50");
    expect(formatCents(100_000, "USD")).toBe("$1,000.00");
  });

  it("formats zero with the currency symbol", () => {
    expect(formatCents(0, "EUR")).toBe("€0.00");
  });

  it("formats a negative amount as a refund", () => {
    expect(formatCents(-300, "USD")).toBe("-$3.00");
  });

  it.each([12.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s as an amount of cents", (cents) => {
    expect(() => formatCents(cents, "USD")).toThrow(RangeError);
  });
});

describe("sumCents", () => {
  it("adds the amounts", () => {
    expect(sumCents([1250, 300, -50])).toBe(1500);
  });

  it("is zero for no amounts", () => {
    expect(sumCents([])).toBe(0);
  });

  it("rejects a fractional amount instead of rounding it", () => {
    expect(() => sumCents([100, 0.5])).toThrow(RangeError);
  });
});
