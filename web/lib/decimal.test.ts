import { describe, expect, it } from "vitest";

import { isDecimalString, splitDecimal, type DecimalString } from "@/lib/decimal";

/**
 * The one shape the wire's decimals come in, pinned where it is defined.
 *
 * `lib/protocol.ts` guards every decimal field with it and `lib/format.ts`
 * renders from it; these tests pin the agreement itself — what the guard
 * accepts is exactly what the split can take apart — so the two doors cannot
 * drift. The junk list is the traps each side learned about: `"1.2.3"` and
 * `"65123."` against naive dot-splitting, `""`/`" "` against `Number("")`
 * being `0`, `"1e3"` against float notation the wire never sends.
 */

describe("isDecimalString", () => {
  it("accepts the wire's plain and signed decimals", () => {
    const valid: DecimalString[] = ["0", "-0", "65164.44", "-0.000001", "1.500000", "007"];
    for (const value of valid) {
      expect(isDecimalString(value)).toBe(true);
    }
  });

  it("rejects everything the format helpers must render as missing", () => {
    const junk: unknown[] = [
      "",
      " ",
      "abc",
      "1.2.3",
      "65123.",
      ".5",
      "1e3",
      "65,164.44",
      "NaN",
      "Infinity",
      null,
      undefined,
      65164.44,
    ];
    for (const value of junk) {
      expect(isDecimalString(value)).toBe(false);
    }
  });
});

describe("splitDecimal", () => {
  it("takes apart everything the guard accepts", () => {
    const valid = ["0", "-0", "65164.44", "-0.000001", "1.500000", "007"];
    for (const value of valid) {
      expect(isDecimalString(value)).toBe(true);
      expect(splitDecimal(value)).not.toBeNull();
    }
    expect(splitDecimal("65123.45")).toEqual({ whole: "65123", fraction: "45" });
    expect(splitDecimal("-0.000001")).toEqual({ whole: "-0", fraction: "000001" });
    expect(splitDecimal("42")).toEqual({ whole: "42", fraction: null });
  });

  it("returns null exactly where the guard says no", () => {
    const junk = ["", "abc", "1.2.3", "65123.", ".5", "1e3", "65,164.44"];
    for (const value of junk) {
      expect(isDecimalString(value)).toBe(false);
      expect(splitDecimal(value)).toBeNull();
    }
  });
});
