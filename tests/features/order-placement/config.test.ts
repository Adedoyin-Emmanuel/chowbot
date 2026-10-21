import { describe, expect, test } from "bun:test";

import { readOrderPlacementConfig } from "../../../features/order-placement/config";

/*
 * The captured website request: methods present and empty, country NG.
 */
const CAPTURED = {
  CHOWBOT_PAYMENT_CHANNEL_METHODS: "",
  CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "NG",
};

describe("readOrderPlacementConfig", () => {
  test("has no defaults: an empty environment enables nothing", () => {
    expect(readOrderPlacementConfig({})).toEqual({ placeOrderEnabled: false, warnings: [] });
  });

  test("accepts the captured values, with methods set but empty", () => {
    const config = readOrderPlacementConfig(CAPTURED);

    expect(config.paymentChannelQuery).toEqual({ methods: "", countryIdentifier: "NG" });
    expect(config.warnings).toEqual([]);
  });

  test("channel values alone never enable place_order", () => {
    expect(readOrderPlacementConfig(CAPTURED).placeOrderEnabled).toBe(false);
  });

  test.each([["false"], ["TRUE"], ["1"], ["yes"], [""]])("only the exact value true enables it, not %p", (flag) => {
    expect(readOrderPlacementConfig({ ...CAPTURED, CHOWBOT_PLACE_ORDER_ENABLED: flag }).placeOrderEnabled).toBe(false);
  });

  test("warns about an unrecognised flag value", () => {
    expect(readOrderPlacementConfig({ CHOWBOT_PLACE_ORDER_ENABLED: "yes" }).warnings[0]).toContain('must be "true" or "false"');
  });

  test.each([
    ["no channel values", {}],
    ["methods unset", { CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "NG" }],
    ["the country unset", { CHOWBOT_PAYMENT_CHANNEL_METHODS: "" }],
  ])("the flag with %s supplies no channel query and warns", (_, env) => {
    const config = readOrderPlacementConfig({ ...env, CHOWBOT_PLACE_ORDER_ENABLED: "true" });

    expect(config.paymentChannelQuery).toBeUndefined();
    expect(config.warnings.join(" ")).toContain("place_order stays disabled");
  });

  test.each([
    ["a guessed non-empty methods value", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_METHODS: "card,opay" }],
    ["a lowercase country", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "ng" }],
    ["another country", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "GH" }],
    ["an empty country", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "" }],
  ])("refuses %s, even with the flag on", (_, env) => {
    const config = readOrderPlacementConfig({ ...env, CHOWBOT_PLACE_ORDER_ENABLED: "true" });

    expect(config.paymentChannelQuery).toBeUndefined();
    expect(config.warnings[0]).toContain("differ from the captured website request");
  });

  test("treats whitespace-only methods as the captured empty value", () => {
    expect(readOrderPlacementConfig({ ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_METHODS: "  " }).paymentChannelQuery).toEqual({
      methods: "",
      countryIdentifier: "NG",
    });
  });

  test("the flag with both captured values enables it", () => {
    const config = readOrderPlacementConfig({ ...CAPTURED, CHOWBOT_PLACE_ORDER_ENABLED: "true" });

    expect(config.placeOrderEnabled).toBe(true);
    expect(config.paymentChannelQuery).toEqual({ methods: "", countryIdentifier: "NG" });
    expect(config.warnings).toEqual([]);
  });
});
