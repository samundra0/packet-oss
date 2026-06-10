import { describe, it, expect } from "vitest";
import { formatSmartPrice } from "@/lib/format";

/**
 * Characterization tests for formatSmartPrice — they lock the function's ACTUAL
 * behavior (adaptive decimals: start at 2 dp, add places until a rounded digit
 * shows, capped at 6 dp). Note the JSDoc example "0.007 -> $0.007" is inaccurate:
 * Math.round(0.007 * 100) === 1 > 0, so it resolves at 2 dp and yields "$0.01".
 * These assertions document what ships today; changing the rule should fail here.
 */
describe("formatSmartPrice", () => {
  it("returns $0.00 for exactly zero", () => {
    expect(formatSmartPrice(0)).toBe("$0.00");
  });

  it("uses 2 decimals for normal prices", () => {
    expect(formatSmartPrice(1.5)).toBe("$1.50");
    expect(formatSmartPrice(10)).toBe("$10.00");
    expect(formatSmartPrice(1.234)).toBe("$1.23");
    expect(formatSmartPrice(0.05)).toBe("$0.05");
  });

  it("rounds at 2 decimals when the rounded hundredths are non-zero", () => {
    // 0.007 * 100 = 0.7 -> rounds to 1 (> 0), so it stops at 2 dp.
    expect(formatSmartPrice(0.007)).toBe("$0.01");
  });

  it("extends decimals when the value would otherwise round to $0.00", () => {
    expect(formatSmartPrice(0.003)).toBe("$0.003"); // needs 3 dp
    expect(formatSmartPrice(0.00003)).toBe("$0.00003"); // needs 5 dp
  });

  it("caps at 6 decimals for values below the visible threshold", () => {
    // 0.0000001 rounds to 0 at every step 2..6 -> falls through to toFixed(6).
    expect(formatSmartPrice(0.0000001)).toBe("$0.000000");
  });

  it("preserves the sign for negative prices", () => {
    expect(formatSmartPrice(-1.5)).toBe("$-1.50");
    expect(formatSmartPrice(-0.003)).toBe("$-0.003");
  });
});
