import { describe, expect, test } from "bun:test";

import { readOrderPlacementConfig } from "../../../features/order-placement/config";

const CHANNEL = {
  CHOWBOT_PAYMENT_CHANNEL_METHODS: "TEST-PLACEHOLDER-METHODS",
  CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "TEST-PLACEHOLDER-COUNTRY",
};

describe("readOrderPlacementConfig", () => {
  test("has no defaults: an empty environment enables nothing", () => {
    expect(readOrderPlacementConfig({})).toEqual({ placeOrderEnabled: false, warnings: [] });
  });

  test("channel values alone never enable place_order", () => {
    const config = readOrderPlacementConfig(CHANNEL);

    expect(config.placeOrderEnabled).toBe(false);
    expect(config.paymentChannelQuery).toEqual({ methods: "TEST-PLACEHOLDER-METHODS", countryIdentifier: "TEST-PLACEHOLDER-COUNTRY" });
  });

  test.each([["false"], ["TRUE"], ["1"], ["yes"], [""]])("only the exact value true enables it, not %p", (flag) => {
    expect(readOrderPlacementConfig({ ...CHANNEL, CHOWBOT_PLACE_ORDER_ENABLED: flag }).placeOrderEnabled).toBe(false);
  });

  test("warns about an unrecognised flag value", () => {
    expect(readOrderPlacementConfig({ CHOWBOT_PLACE_ORDER_ENABLED: "yes" }).warnings[0]).toContain('must be "true" or "false"');
  });

  test.each([
    ["no channel values", {}],
    ["only methods", { CHOWBOT_PAYMENT_CHANNEL_METHODS: "x" }],
    ["a blank country identifier", { ...CHANNEL, CHOWBOT_PAYMENT_CHANNEL_COUNTRY_IDENTIFIER: "  " }],
  ])("the flag with %s supplies no channel query and warns", (_, env) => {
    const config = readOrderPlacementConfig({ ...env, CHOWBOT_PLACE_ORDER_ENABLED: "true" });

    expect(config.paymentChannelQuery).toBeUndefined();
    expect(config.warnings[0]).toContain("place_order stays disabled");
  });

  test("the flag with both channel values enables it", () => {
    const config = readOrderPlacementConfig({ ...CHANNEL, CHOWBOT_PLACE_ORDER_ENABLED: "true" });

    expect(config.placeOrderEnabled).toBe(true);
    expect(config.paymentChannelQuery).toBeDefined();
    expect(config.warnings).toEqual([]);
  });
});
