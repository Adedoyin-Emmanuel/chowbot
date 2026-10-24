import { describe, expect, test } from "bun:test";

import { parseRequestTimeoutMs } from "../../constants/chowdeck";

describe("parseRequestTimeoutMs", () => {
  test.each([undefined, "", "   "])("defaults to 15000ms for %p", (value) => {
    expect(parseRequestTimeoutMs(value)).toBe(15000);
  });

  test.each([
    ["5000", 5000],
    [" 250 ", 250],
  ])("accepts %p", (value, expected) => {
    expect(parseRequestTimeoutMs(value)).toBe(expected);
  });

  test.each(["abc", "15000ms", "-5", "0", "1.5", "1e3", "0x10", "99999999999999999999"])(
    "rejects %p",
    (value) => {
      expect(() => parseRequestTimeoutMs(value)).toThrow(
        "CHOWDECK_REQUEST_TIMEOUT_MS must be a positive whole number of milliseconds",
      );
    },
  );
});
