import { describe, expect, test } from "bun:test";

import {
  formatNaira,
  tipFromNaira,
  parseTipConfig,
  validatePromoCode,
  validateGiftRecipient,
  type TipConfig,
} from "../../../features/checkout/draft";

/*
 * Draft extras: promo code, tip and gift recipient. Values are fictional;
 * tip limits follow the shape and example values seen in Chowdeck's config
 * (minimum 10000, maximum 500000, raw x100).
 */

const LIMITS: TipConfig = { available: true, minimum: 10000, maximum: 500000 };

describe("validatePromoCode", () => {
  test.each([["SAVE10", "SAVE10"], ["  chow-free_1  ", "chow-free_1"], ["A".repeat(40), "A".repeat(40)]])("accepts %p as %p, keeping case", (input, code) => {
    expect(validatePromoCode(input)).toEqual({ ok: true, value: code });
  });

  test.each([[""], ["   "], ["SAVE 10"], ["SAVE10!"], ["A".repeat(41)], ["ÇÖDE"]])("refuses %p", (input) => {
    expect(validatePromoCode(input).ok).toBe(false);
  });
});

describe("parseTipConfig", () => {
  test("reads the website's tip configuration fields", () => {
    expect(
      parseTipConfig({
        status: "success",
        data: {
          delivery_driver_tips_config: { recommendation_percent: [5, 10, "Custom"], default_percent: "", minimum_tip_amount: 10000, maximum_tip_amount: 500000 },
        },
      }),
    ).toEqual({ available: true, minimum: 10000, maximum: 500000 });
  });

  test.each([
    ["no tips config", { data: {} }, { available: false, minimum: 0, maximum: 0 }],
    ["no recommendation list (the website then shows no tip control)", { data: { delivery_driver_tips_config: { minimum_tip_amount: 10000 } } }, { available: false, minimum: 10000, maximum: 0 }],
    ["malformed limits", { data: { delivery_driver_tips_config: { recommendation_percent: [5], minimum_tip_amount: "100", maximum_tip_amount: -1 } } }, { available: true, minimum: 0, maximum: 0 }],
  ])("handles %s", (_, body, expected) => {
    expect(parseTipConfig(body)).toEqual(expected);
  });

  test("gives nothing for a body without data", () => {
    expect(parseTipConfig({ status: "failed" })).toBeUndefined();
    expect(parseTipConfig(null)).toBeUndefined();
  });
});

describe("tipFromNaira", () => {
  test.each([
    [100, 10000, "₦100.00"],
    [250.5, 25050, "₦250.50"],
    [0.1 + 0.2 + 99.7, 10000, "₦100.00"],
    [5000, 500000, "₦5,000.00"],
  ])("converts ₦%p to raw %p exactly once", (naira, raw, display) => {
    expect(tipFromNaira(naira, LIMITS)).toEqual({ ok: true, value: { kind: "amount", raw, naira: raw / 100, display } });
  });

  test("treats 0 as no tip, without needing limits", () => {
    expect(tipFromNaira(0, undefined)).toEqual({ ok: true, value: { kind: "none", reason: "a tip of 0 is no tip; the website never sends tip: 0" } });
  });

  test.each([
    [-1, "must be a number of naira, 0 or more"],
    [Number.NaN, "must be a number of naira, 0 or more"],
    [Number.POSITIVE_INFINITY, "must be a number of naira, 0 or more"],
    [100.555, "must have at most two decimal places (kobo)"],
    [99.99, "must be at least ₦100.00"],
    [5000.01, "must be at most ₦5,000.00"],
  ])("refuses %p", (naira, error) => {
    expect(tipFromNaira(naira, LIMITS)).toEqual({ ok: false, error });
  });

  test("uses inclusive bounds, and no upper bound when the maximum is 0", () => {
    expect(tipFromNaira(100, LIMITS).ok).toBe(true);
    expect(tipFromNaira(5000, LIMITS).ok).toBe(true);
    expect(tipFromNaira(1_000_000, { available: true, minimum: 0, maximum: 0 }).ok).toBe(true);
  });

  test("refuses a tip when limits are unknown or tips are unavailable", () => {
    expect(tipFromNaira(200, undefined)).toEqual({ ok: false, error: "cannot be checked: Chowdeck's tip limits could not be read" });
    expect(tipFromNaira(200, { available: false, minimum: 0, maximum: 0 })).toEqual({ ok: false, error: "is not available: Chowdeck's configuration offers no rider tips" });
  });

  test("refuses an amount too large to represent exactly", () => {
    expect(tipFromNaira(1e15, { available: true, minimum: 0, maximum: 0 })).toEqual({ ok: false, error: "is too large" });
  });

  test("formats raw amounts as naira", () => {
    expect(formatNaira(123456)).toBe("₦1,234.56");
  });
});

describe("validateGiftRecipient", () => {
  const valid = { donor_name: " Ada ", name: " Tunde Example ", phone: " 08012345678 " };

  test("builds the website's gift object, trimmed, with defaults", () => {
    expect(validateGiftRecipient(valid)).toEqual({
      ok: true,
      value: { country_code: "NG", phone: "08012345678", donor_name: "Ada", name: "Tunde Example", message: "", save_as_beneficiary: false },
    });
  });

  test("keeps optional fields only when given, and accepts Unicode names and messages", () => {
    const result = validateGiftRecipient({
      ...valid,
      name: "Ìyá Ọlọ́jà",
      country_code: "gh",
      email: " friend@example.com ",
      message: " Happy birthday! 🎉\nEnjoy ",
      save_as_beneficiary: true,
    });

    expect(result).toEqual({
      ok: true,
      value: {
        country_code: "GH",
        phone: "08012345678",
        donor_name: "Ada",
        name: "Ìyá Ọlọ́jà",
        email: "friend@example.com",
        message: "Happy birthday! 🎉\nEnjoy",
        save_as_beneficiary: true,
      },
    });
  });

  test.each([
    ["a blank recipient name", { name: "   " }, "name is required"],
    ["a blank sender name", { donor_name: "" }, "donor_name is required"],
    ["a missing phone", { phone: "  " }, "phone is required"],
    ["letters in the phone", { phone: "0801-CALL-ME" }, "phone must be 7-15 digits"],
    ["too few digits", { phone: "12345" }, "phone must be 7-15 digits"],
    ["too many digits", { phone: "+1234567890123456" }, "phone must be 7-15 digits"],
    ["a bad country code", { country_code: "NGA" }, "country_code must be a two-letter country code"],
    ["a bad email", { email: "not-an-email" }, "email is not a valid email address"],
    ["a long name", { name: "a".repeat(101) }, "name is longer than 100 characters"],
    ["a long message", { message: "m".repeat(501) }, "message is longer than 500 characters"],
    ["control characters", { message: "hi \u0007" }, "message contains control characters"],
    ["a leading +", { phone: "+2348012345678" }, "phone must be 7-15 digits only"],
    ["spaces in the phone", { phone: "0801 234 5678" }, "phone must be 7-15 digits only"],
    ["dashes in the phone", { phone: "0801-234-5678" }, "phone must be 7-15 digits only"],
    ["a multi-line recipient name", { name: "Tunde\nExample" }, "name contains control characters"],
  ])("refuses %s", (_, override, error) => {
    const result = validateGiftRecipient({ ...valid, ...override });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain(error);
  });

  test("accepts Windows and Unix line breaks in the message only", () => {
    const result = validateGiftRecipient({ ...valid, message: "Line one\r\nLine two\nLine three" });

    expect(result.ok && result.value.message).toBe("Line one\r\nLine two\nLine three");
  });

  test("treats a blank email as absent", () => {
    const result = validateGiftRecipient({ ...valid, email: "  " });

    expect(result.ok && result.value).not.toHaveProperty("email");
  });
});
