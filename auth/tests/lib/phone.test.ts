import { describe, expect, test } from "bun:test";

import {
  formatNational,
  isValidNational,
  nationalDigits,
  toInternational,
} from "../../src/lib/phone";
import { NIGERIAN_PHONE_PATTERN } from "../../../mcp-server/features/auth/service";

describe("nationalDigits", () => {
  test.each([
    ["08012345678", "8012345678"],
    ["8012345678", "8012345678"],
    ["+234 801 234 5678", "8012345678"],
    ["2348012345678", "8012345678"],
    ["0801-234-5678", "8012345678"],
    ["(0801) 234 5678", "8012345678"],
  ])("reads %s as %s", (input, digits) => {
    expect(nationalDigits(input)).toBe(digits);
  });

  test("stops at ten digits", () => {
    expect(nationalDigits("801234567899")).toBe("8012345678");
  });
});

describe("isValidNational", () => {
  test.each(["8012345678", "7012345678", "9012345678", "8112345678"])(
    "accepts %s",
    (digits) => {
      expect(isValidNational(digits)).toBe(true);
    },
  );

  test.each(["", "801234567", "6012345678", "8212345678", "80123456ab"])(
    "rejects %p",
    (digits) => {
      expect(isValidNational(digits)).toBe(false);
    },
  );
});

test("groups the number as it is typed", () => {
  expect(formatNational("")).toBe("");
  expect(formatNational("80")).toBe("80");
  expect(formatNational("8012")).toBe("801 2");
  expect(formatNational("8012345678")).toBe("801 234 5678");
});

test("sends the number in international form, which the server accepts", () => {
  expect(toInternational("8012345678")).toBe("+2348012345678");
  expect(NIGERIAN_PHONE_PATTERN.test(toInternational("8012345678"))).toBe(true);
});
