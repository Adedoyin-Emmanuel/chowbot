import type { Server } from "bun";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { randomBytes } from "node:crypto";

import { ChowdeckClient } from "../../../lib/client";
import { createServer } from "../../../mcp/server";
import { readOrderPlacementConfig } from "../../../features/order-placement/config";
import { createKeyring } from "../../../lib/encryption";
import { createChowbotRequestStateCodec } from "../../../lib/request-state";
import { CAPTURED_PAYMENT_CHANNEL_QUERY, resolvePaymentChannel } from "../../../features/order-placement/channels";

/*
 * The response shape follows the sanitized channel capture (id, name,
 * processor, is_active; eight channels including opay). The query is the
 * captured website request: methods present and empty, country_identifier NG.
 */
const QUERY = CAPTURED_PAYMENT_CHANNEL_QUERY;
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
let seen: { path: string; search: string; query: URLSearchParams; authorization: string | null }[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      seen.push({ path: url.pathname, search: url.search, query: url.searchParams, authorization: req.headers.get("authorization") });
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
  test("sends exactly the captured query, with methods present and empty, and the user's token", async () => {
    reply = () => Response.json({ status: "success", message: "Payment channels retrieved successfully", data: OBSERVED_CHANNELS });

    expect(await resolve()).toEqual({ id: 3, name: "opay" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.path).toBe("/customer/payment/channel");
    expect(seen[0]!.search).toBe("?methods=&country_identifier=NG");
    expect([...seen[0]!.query.keys()]).toEqual(["methods", "country_identifier"]);
    expect(seen[0]!.query.get("methods")).toBe("");
    expect(seen[0]!.authorization).toBe("Bearer secret-token-alice");
  });

  test("the captured query is fixed", () => {
    expect(CAPTURED_PAYMENT_CHANNEL_QUERY).toEqual({ methods: "", countryIdentifier: "NG" });
    expect(Object.isFrozen(CAPTURED_PAYMENT_CHANNEL_QUERY)).toBe(true);
  });

  test("returns opay's numeric id and name from all eight observed channels, whatever their order", async () => {
    reply = () => Response.json({ status: "success", data: [...OBSERVED_CHANNELS].reverse() });

    const channel = await resolve();

    expect(channel).toEqual({ id: 3, name: "opay" });
    expect(Number.isSafeInteger(channel!.id)).toBe(true);
  });

  test("takes the id from the active opay entry when an inactive one is listed first", async () => {
    reply = () =>
      Response.json({
        status: "success",
        data: [{ id: 30, name: "opay", processor: "opay", is_active: 0 }, ...OBSERVED_CHANNELS],
      });

    expect(await resolve()).toEqual({ id: 3, name: "opay" });
  });

  test("accepts is_active: true as active", async () => {
    reply = () => Response.json({ status: "success", data: [{ id: 9, name: "opay", processor: "opay", is_active: true }] });

    expect(await resolve()).toEqual({ id: 9, name: "opay" });
  });

  test.each([
    ["absent", OBSERVED_CHANNELS.filter((c) => c.name !== "opay")],
    ["inactive", OBSERVED_CHANNELS.map((c) => (c.name === "opay" ? { ...c, is_active: 0 } : c))],
    ["marked inactive with false", OBSERVED_CHANNELS.map((c) => (c.name === "opay" ? { ...c, is_active: false } : c))],
    ["missing is_active", OBSERVED_CHANNELS.map(({ is_active: _, ...c }) => c)],
    ["marked active with a string", OBSERVED_CHANNELS.map((c) => (c.name === "opay" ? { ...c, is_active: "1" } : c))],
    ["named differently", OBSERVED_CHANNELS.map((c) => (c.name === "opay" ? { ...c, name: "OPay" } : c))],
  ])("returns nothing when the channel is %s", async (_, data) => {
    reply = () => Response.json({ status: "success", data });

    expect(await resolve()).toBeUndefined();
  });

  test.each([
    ["data is not a list", { data: {} }],
    ["a channel has no numeric id", { data: [{ id: "3", name: "opay" }] }],
    ["a channel has no name", { data: [{ id: 3 }] }],
    ["a channel id is fractional", { data: [{ id: 3.5, name: "opay", is_active: 1 }] }],
    ["a channel id is zero", { data: [{ id: 0, name: "opay", is_active: 1 }] }],
    ["data is missing", { status: "success" }],
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

/*
 * Guards for enablement: until the real channel query values and the
 * payment-start redirect values are captured, production must not supply
 * placeholder values (so place_order stays unregistered) and nothing may
 * start a payment.
 */
describe("production configuration", () => {
  const ROOT = `${import.meta.dir}/../../..`;
  const productionSources = async () => {
    const sources: { path: string; text: string }[] = [];
    for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: ROOT })) {
      if (/^(tests|node_modules|dist)\//.test(path)) continue;
      sources.push({ path, text: await Bun.file(`${ROOT}/${path}`).text() });
    }
    return sources;
  };

  test("contains no placeholder channel query values", async () => {
    const leaks = (await productionSources()).filter(({ text }) => text.includes("PLACEHOLDER"));

    expect(leaks.map(({ path }) => path)).toEqual([]);
  });

  test("the hosted entry point takes place_order settings only from the environment", async () => {
    const entry = await Bun.file(`${ROOT}/http.ts`).text();

    expect(entry).toContain("readOrderPlacementConfig(process.env)");
    expect(entry).not.toMatch(/methods\s*:|countryIdentifier\s*:|placeOrderEnabled\s*:\s*true/);
  });

  test("only the start_payment service names the payment-start endpoint", async () => {
    const callers = (await productionSources()).filter(({ text }) => text.includes("/payment/start"));

    expect(callers.map(({ path }) => path)).toEqual(["features/payments/service.ts"]);
  });

  test("the hosted entry point enables start_payment only with live ordering, on the website's origin", async () => {
    const entry = await Bun.file(`${ROOT}/http.ts`).text();

    expect(entry).toContain("...(placeOrderEnabled && { paymentStartConfig: createPaymentStartConfig() })");
    expect(entry.match(/paymentStartConfig/g)).toHaveLength(1);
  });

  test("tracked configuration leaves live ordering at its default, with no unobserved channel values", async () => {
    for (const file of ["Dockerfile", "compose.yml"]) {
      expect(await Bun.file(`${ROOT}/${file}`).text()).not.toContain("CHOWBOT_");
    }
    const example = Object.fromEntries(
      (await Bun.file(`${ROOT}/.env.example`).text())
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(readOrderPlacementConfig(example)).toMatchObject({ placeOrderEnabled: true, warnings: [] });
  });

  test("the production server composition registers neither place_order nor start_payment", async () => {
    const server = createServer({
      session: { get: async () => undefined, save: async () => {}, clear: async () => {} },
      submissions: {} as never,
      requestStateCodec: createChowbotRequestStateCodec(createKeyring(randomBytes(32)).requestStateKey),
    });
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

    expect(names).toContain("get_order_submission");
    expect(names).not.toContain("place_order");
    expect(names).not.toContain("start_payment");
  });
});
