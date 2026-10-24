import { describe, expect, test } from "bun:test";

import { parseTrustProxyHops } from "../../constants/app";

describe("parseTrustProxyHops", () => {
  test("defaults to trusting no proxy", () => {
    expect(parseTrustProxyHops(undefined)).toBe(0);
    expect(parseTrustProxyHops("  ")).toBe(0);
  });

  test("reads a whole number of proxies", () => {
    expect(parseTrustProxyHops("2")).toBe(2);
    expect(parseTrustProxyHops(" 1 ")).toBe(1);
  });

  test.each(["-1", "1.5", "true", "loopback"])("rejects %s", (value) => {
    expect(() => parseTrustProxyHops(value)).toThrow("CHOWBOT_TRUST_PROXY_HOPS must be a whole number");
  });
});
