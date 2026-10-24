import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { McpServer } from "@modelcontextprotocol/server";

import { callTool, rpc } from "../../helpers/mcp";
import { createServer } from "../../../mcp/server";
import { ChowdeckClient } from "../../../lib/client";
import { registerRestaurantTools } from "../../../features/restaurants/tools";
import { InMemorySessionStore, bindSession, type UserSession } from "../../../lib/session";

/*
 * Response shapes from the user's capture of 2026-10-23 (address 13385656);
 * private-looking values carry a "PRIVATE-" marker.
 */
type Received = { url: URL; authorization: string | null };

let upstream: Server<undefined>;
let routes: Map<string, () => Response>;
let received: Received[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      received.push({ url, authorization: req.headers.get("authorization") });
      const handler = routes.get(url.pathname);
      return handler ? handler() : Response.json({ message: "unexpected request" }, { status: 500 });
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  routes = new Map();
  received = [];
});

const call = async (tool: string, args: Record<string, unknown>, session?: UserSession) =>
  callTool(
    () => {
      const server = new McpServer({ name: "ChowBot", version: "test" });
      registerRestaurantTools(server, session, new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }));
      return server;
    },
    tool,
    args,
  );

const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);

const signedIn = async () => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save({ token: "secret-token-alice" });
  return session;
};

const vendor = (overrides: Record<string, unknown> = {}) => ({
  id: 118195,
  name: "Item 7 (Go) - Allen",
  slug: "item-7-(go)-bodijalagos2r37px",
  logo_url: "https://files.chowdeck.com/images/logo.png",
  cover_images: [{ path: "https://files.chowdeck.com/images/cover.png" }],
  vendor_type: "restaurant",
  vendor_class: "instant",
  average_rating: "4.59",
  number_of_rating: 34,
  location: "Ikeja",
  city: "Ikeja GRA",
  is_open: true,
  current_is_open_state: 1,
  is_temporarily_unavailable: false,
  temporarily_unavailable_tag: "Kitchen is full",
  opening_time_text: null,
  delivery_price: 55000,
  minimum_order_amount: 100000,
  minimum_delivery_time: 16,
  maximum_delivery_time: 26,
  distance: 0.52,
  discount_text: "",
  tag: ["lovedeal"],
  available_hours: { default: { opening: "0000", closing: "2359" } },
  registration_status: { bank_information: 1 },
  ads_campaign_id: 3922,
  ...overrides,
});

const list = (data: unknown[], meta?: Record<string, unknown>) => () =>
  Response.json({ status: "success", message: "Vendors retrieved successfully", data, ...(meta && { meta }) });

describe("restaurant tools", () => {
  test("are registered with read-only annotations", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    for (const name of ["search_restaurants", "browse_restaurants"]) {
      const tool = tools.find((t: { name: string }) => t.name === name);
      expect(tool.annotations.readOnlyHint).toBe(true);
      expect(tool.inputSchema.required).toContain("address_id");
    }
  });
});

describe("search_restaurants", () => {
  test("uses Chowdeck's search with the query, address and type, and lists matching dishes under each place", async () => {
    routes.set("/customer/search/product", list([
      vendor({
        products: [
          { id: 1110006, name: "Beef shawarma", description: "Large", price: 420000, discount_price: null, in_stock: true, is_active: true, is_published: true, cost_price: 0, commission_percent: 0 },
          { id: 1, name: "Hidden", price: 1, in_stock: true, is_active: false },
        ],
      }),
      vendor({ id: 100297, name: "Shawarma Place", products: [] }),
    ]));

    const result = await call("search_restaurants", { address_id: 13385656, query: "shawarma", type: "restaurant" });
    const parsed = parse(result);

    expect(result.isError).toBeUndefined();
    const { url } = received[0]!;
    expect(url.pathname).toBe("/customer/search/product");
    expect(Object.fromEntries(url.searchParams)).toEqual({ address_id: "13385656", query: "shawarma", type: "restaurant" });
    expect(parsed.results[0]).toEqual({
      id: 118195,
      name: "Item 7 (Go) - Allen",
      vendor_type: "restaurant",
      vendor_class: "instant",
      location: "Ikeja",
      city: "Ikeja GRA",
      average_rating: "4.59",
      number_of_rating: 34,
      is_open: true,
      is_temporarily_unavailable: false,
      opening_time_text: null,
      delivery_price: "₦550.00",
      minimum_order_amount: "₦1,000.00",
      minimum_delivery_time: 16,
      maximum_delivery_time: 26,
      distance: 0.52,
      matching_items: [{ id: 1110006, name: "Beef shawarma", description: "Large", price: "₦4,200.00", discount_price: null, in_stock: true }],
    });
    expect(parsed.results[1]).not.toHaveProperty("matching_items");
    expect(result.content[0]!.text).not.toMatch(/logo|cover|ads_campaign|registration|commission|cost_price/);
  });

  test("searches everything when no type is given", async () => {
    routes.set("/customer/search/product", list([]));

    await call("search_restaurants", { address_id: 13385656, query: "rice" });

    expect(received[0]!.url.searchParams.has("type")).toBe(false);
  });

  test.each(["vouchers", "relay", "local_market"])("refuses the %s type before contacting Chowdeck", async (type) => {
    const result = await call("search_restaurants", { address_id: 13385656, query: "rice", type });

    expect(result.isError).toBe(true);
    expect(received).toHaveLength(0);
  });

  test("says why a place is temporarily unavailable", async () => {
    routes.set("/customer/search/product", list([vendor({ is_temporarily_unavailable: true })]));

    const parsed = parse(await call("search_restaurants", { address_id: 13385656, query: "rice" }));

    expect(parsed.results[0]).toMatchObject({ is_temporarily_unavailable: true, unavailable_reason: "Kitchen is full" });
  });

  test("reports Chowdeck's failure and an unexpected shape as errors", async () => {
    routes.set("/customer/search/product", () => Response.json({ status: "failed", message: "Please provide a valid vendor type" }, { status: 400 }));
    const rejected = await call("search_restaurants", { address_id: 13385656, query: "rice" });
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0]!.text).toContain("Please provide a valid vendor type");

    routes.set("/customer/search/product", () => Response.json({ status: "success", data: { vendors: [] } }));
    const malformed = await call("search_restaurants", { address_id: 13385656, query: "rice" });
    expect(malformed.content[0]!.text).toContain("returned an unexpected response shape");
  });

  test("sends the signed-in user's token, and works signed out", async () => {
    routes.set("/customer/search/product", list([]));

    await call("search_restaurants", { address_id: 1, query: "rice" }, await signedIn());
    await call("search_restaurants", { address_id: 1, query: "rice" });

    expect(received.map((r) => r.authorization)).toEqual(["Bearer secret-token-alice", null]);
  });
});

describe("browse_restaurants", () => {
  test("lists nearby places and passes Chowdeck's cursor back for the next page", async () => {
    routes.set("/customer/vendor/v2", list([vendor()], { next_cursor: "eyJvZmZzZXQiOjEwMH0=", has_more: true }));

    const first = parse(await call("browse_restaurants", { address_id: 13385656 }));
    await call("browse_restaurants", { address_id: 13385656, next_cursor: first.next_cursor });

    expect(first).toMatchObject({ collection: "nearby", returned: 1, next_cursor: "eyJvZmZzZXQiOjEwMH0=" });
    expect(first.restaurants[0]).toMatchObject({ id: 118195, delivery_price: "₦550.00" });
    expect(received[1]!.url.searchParams.get("next_cursor")).toBe("eyJvZmZzZXQiOjEwMH0=");
  });

  test("gives no cursor on the last page", async () => {
    routes.set("/customer/vendor/v2", list([vendor()], { next_cursor: "x", has_more: false }));

    expect(parse(await call("browse_restaurants", { address_id: 1 }))).not.toHaveProperty("next_cursor");
  });

  test.each(["handpicked", "featured"])("lists Chowdeck's %s places", async (collection) => {
    routes.set("/customer/vendor/special/v2", list([vendor()]));

    const parsed = parse(await call("browse_restaurants", { address_id: 13385656, collection }));

    expect(Object.fromEntries(received[0]!.url.searchParams)).toEqual({ address_id: "13385656", tag: collection });
    expect(parsed).toMatchObject({ collection, returned: 1 });
  });

  test("filters by kind of place and by open now", async () => {
    routes.set("/customer/vendor/v2", list([
      vendor(),
      vendor({ id: 2, vendor_type: "pharmacy" }),
      vendor({ id: 3, is_open: false }),
      vendor({ id: 4, is_temporarily_unavailable: true }),
    ]));

    const parsed = parse(await call("browse_restaurants", { address_id: 1, vendor_type: "restaurant", open_now: true }));

    expect(parsed.restaurants.map((r: { id: number }) => r.id)).toEqual([118195]);
  });

  test("order_again lists the user's frequent places with what they last ordered", async () => {
    routes.set("/customer/vendor/frequent", () =>
      Response.json({
        status: "success",
        message: "Frequent vendors fetched successfully",
        data: [
          {
            vendor_id: 118195, vendor_name: "Item 7 (Go) - Allen", vendor_type: "restaurant", location: "Ikeja", slug: "item-7",
            order_id: 42965098, total_price: 960000, currency: "NGN",
            items: [{ item_id: 1110010, name: "A plate of rice with chicken", image: { path: "https://files.chowdeck.com/x.png" }, is_available: false }],
          },
        ],
      }),
    );

    const result = await call("browse_restaurants", { address_id: 13385656, collection: "order_again" }, await signedIn());
    const parsed = parse(result);

    expect(received[0]!.authorization).toBe("Bearer secret-token-alice");
    expect(parsed.restaurants).toEqual([
      {
        vendor_id: 118195, vendor_name: "Item 7 (Go) - Allen", vendor_type: "restaurant", location: "Ikeja", order_id: 42965098,
        total_price: "₦9,600.00",
        last_order_items: [{ item_id: 1110010, name: "A plate of rice with chicken", is_available: false }],
      },
    ]);
    expect(result.content[0]!.text).not.toContain("files.chowdeck.com");
  });
});
