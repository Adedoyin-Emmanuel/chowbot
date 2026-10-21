import type { Server } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { ChowdeckClient } from "../../../lib/client";
import { resolvePaymentChannel } from "../../../features/order-placement/channels";

/*
 * The response shape follows the sanitized channel capture (id, name,
 * processor, is_active; eight channels including opay). The query values
 * are placeholders: the real ones have not been observed.
 */
const QUERY = { methods: "TEST-PLACEHOLDER-METHODS", countryIdentifier: "TEST-PLACEHOLDER-COUNTRY" };
const OBSERVED_CHANNELS = [
  { id: 1, name: "card", processor: "paystack", is_active: 1 },
  { id: 2, name: "bank_transfer", processor: "paystack", is_active: 1 },
  { id: 3, name: "opay", processor: "opay", is_active: 1 },
  { id: 4, name: "bank", processor: "paystack", is_active: 1 },
  { id: 5, name: "ussd", processor: "paystack", is_active: 1 },
  { id: 6, name: "qr", processor: "paystack", is_active: 1 },
  { id: 7, name: "pocket", processor: "pocket", is_active: 1 },
  { id: 8, name: "zap", processor: "paystack", is_active: 1 },
];

let upstream: Server<undefined>;
let reply: () => Response;
let seen: { path: string; query: URLSearchParams; authorization: string | null }[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, query: url.searchParams, authorization: req.headers.get("authorization") });
      return reply();
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  seen = [];
});

const client = () => new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 });
const resolve = () => resolvePaymentChannel(client(), { authorization: "Bearer secret-token-alice" }, QUERY, "opay");

describe("resolvePaymentChannel", () => {
  test("sends the configured query values verbatim with the user's token and returns the channel id", async () => {
    reply = () => Response.json({ status: "success", message: "Payment channels retrieved successfully", data: OBSERVED_CHANNELS });

    expect(await resolve()).toEqual({ id: 3, name: "opay" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/customer/payment/channel");
    expect(Object.fromEntries(seen[0]!.query)).toEqual({
      methods: "TEST-PLACEHOLDER-METHODS",
      country_identifier: "TEST-PLACEHOLDER-COUNTRY",
    });
    expect(seen[0]!.authorization).toBe("Bearer secret-token-alice");
  });

  test.each([
    ["absent", OBSERVED_CHANNELS.filter((c) => c.name !== "opay")],
    ["inactive", OBSERVED_CHANNELS.map((c) => (c.name === "opay" ? { ...c, is_active: 0 } : c))],
  ])("returns nothing when the channel is %s", async (_, data) => {
    reply = () => Response.json({ status: "success", data });

    expect(await resolve()).toBeUndefined();
  });

  test.each([
    ["data is not a list", { data: {} }],
    ["a channel has no numeric id", { data: [{ id: "3", name: "opay" }] }],
    ["a channel has no name", { data: [{ id: 3 }] }],
  ])("rejects a malformed response when %s", async (_, body) => {
    reply = () => Response.json(body);

    await expect(resolve()).rejects.toThrow("GET /customer/payment/channel returned an unexpected response shape");
  });

  test("passes upstream errors through without retrying", async () => {
    reply = () => Response.json({ message: "Server Error" }, { status: 500 });

    await expect(resolve()).rejects.toThrow("failed with status 500");
    expect(seen).toHaveLength(1);
  });
});
