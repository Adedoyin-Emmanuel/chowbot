import { describe, expect, test } from "bun:test";

import { readOrderPlacementConfig } from "../../../features/order-placement/config";

/*
 * Live ordering is on by default; CHOWBOT_PLACE_ORDER_ENABLED=false is the
 * kill switch. The channel query may only be overridden with its defaults.
 */

const CAPTURED = {
  CHOWBOT_PAYMENT_CHANNEL_METHODS: "",
  CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "NG",
};

describe("readOrderPlacementConfig", () => {
  test("is on by default, with the captured channel query", () => {
    expect(readOrderPlacementConfig({})).toEqual({
      placeOrderEnabled: true,
      paymentChannelQuery: { methods: "", countryIdentifier: "NG" },
      warnings: [],
    });
  });

  test.each([["true"], [""], ["  true  "]])("stays on for %p", (flag) => {
    expect(readOrderPlacementConfig({ CHOWBOT_PLACE_ORDER_ENABLED: flag }).placeOrderEnabled).toBe(true);
  });

  test("the kill switch turns it off without a warning", () => {
    expect(readOrderPlacementConfig({ CHOWBOT_PLACE_ORDER_ENABLED: "false" })).toMatchObject({ placeOrderEnabled: false, warnings: [] });
  });

  test.each([["TRUE"], ["1"], ["yes"], ["off"]])("treats the unrecognised value %p as off, with a warning", (flag) => {
    const config = readOrderPlacementConfig({ CHOWBOT_PLACE_ORDER_ENABLED: flag });

    expect(config.placeOrderEnabled).toBe(false);
    expect(config.warnings[0]).toContain('must be "true" or "false" (or unset)');
  });

  test("accepts the captured values when set explicitly, with methods set but empty", () => {
    expect(readOrderPlacementConfig(CAPTURED)).toEqual({
      placeOrderEnabled: true,
      paymentChannelQuery: { methods: "", countryIdentifier: "NG" },
      warnings: [],
    });
  });

  test("treats whitespace-only methods as the captured empty value", () => {
    expect(readOrderPlacementConfig({ ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_METHODS: "  " }).placeOrderEnabled).toBe(true);
  });

  test.each([
    ["a guessed non-empty methods value", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_METHODS: "card,opay" }],
    ["a lowercase country", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "ng" }],
    ["another country", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "GH" }],
    ["an empty country", { ...CAPTURED, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "" }],
    ["only methods set", { CHOWBOT_PAYMENT_CHANNEL_METHODS: "" }],
    ["only the country set", { CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "NG" }],
  ])("turns live ordering off for %s, rather than sending an unobserved query", (_, env) => {
    const config = readOrderPlacementConfig(env);

    expect(config.placeOrderEnabled).toBe(false);
    expect(config.paymentChannelQuery).toBeUndefined();
    expect(config.warnings[0]).toContain("differ from the captured website request");
  });

  test("the kill switch wins over valid channel values", () => {
    expect(readOrderPlacementConfig({ ...CAPTURED, CHOWBOT_PLACE_ORDER_ENABLED: "false" }).placeOrderEnabled).toBe(false);
  });
});
