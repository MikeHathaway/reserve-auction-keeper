import { describe, expect, it } from "vitest";
import { parseEther } from "viem";
import {
  calculateReserveTakeAjnaCost,
  normalizeReserveTakeAmount,
  toRawQuoteTokenAmount,
} from "../../src/auction/math.js";

describe("reserve auction math", () => {
  it("rounds quote amounts down to the token scale", () => {
    expect(normalizeReserveTakeAmount(parseEther("1") + 123n, 1_000_000_000_000n))
      .toBe(parseEther("1"));
  });

  it("rounds AJNA cost up for fractional wad multiplication", () => {
    expect(calculateReserveTakeAjnaCost(100n, parseEther("1") + 1n)).toBe(101n);
  });

  it("converts normalized reserve amounts to raw quote-token units", () => {
    expect(toRawQuoteTokenAmount(parseEther("25"), 1_000_000_000_000n)).toBe(25_000_000n);
  });
});
