import {
  test,
  expect,
  describe,
  afterAll,
  beforeAll,
  beforeEach,
} from "bun:test";
import type { Server } from "bun";
import { McpServer } from "@modelcontextprotocol/server";

import {
  bindSession,
  InMemorySessionStore,
  type UserSession,
} from "../../../lib/session";
import { callTool, rpc } from "../../helpers/mcp";
import { createServer } from "../../../mcp/server";
import { ChowdeckClient } from "../../../lib/client";
import { registerCartTools } from "../../../features/carts/tools";

type ReceivedRequest = {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
};

type Handler = () => Response;

let upstream: Server<undefined>;
let received: ReceivedRequest[];
let routes: Map<string, Handler[]>;

/*
 * Each "METHOD /path" key holds a queue of responses, so a flow that reads
 * the same cart before and after a write can be scripted in order.
 */
const route = (key: string, ...handlers: Handler[]) => routes.set(key, handlers);

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const text = await req.text();
      received.push({
        method: req.method,
        path,
        authorization: req.headers.get("authorization"),
        body: text ? JSON.parse(text) : undefined,
      });
      const queue = routes.get(`${req.method} ${path}`);
      const handler = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      return handler ? handler() : Response.json({ message: "unexpected request" }, { status: 500 });
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  received = [];
  routes = new Map();
});

const sessionWith = async (fields: { token?: string; guestId?: string }) => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save(fields);
  return session;
};

const signedIn = () => sessionWith({ token: "secret-token-alice" });

const serverFor = (session?: UserSession) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerCartTools(
    server,
    session,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;
const writes = () => received.filter((r) => r.method === "POST");

/*
 * Fixtures copied from the sanitized Chowdeck capture (2026-10-20): vendor
 * 102555, Fried Rice 880557 and its Size/Packaging groups, and the cart rows
 * and pack references observed after the two approved adds. The address ID
 * was redacted in the capture, so 555 is a test value.
 */
const ADDRESS_ID = 555;

const addressList = () =>
  Response.json({ status: "success", data: [{ id: ADDRESS_ID, pretty_name: "Home" }] });

const friedRiceDetail = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    message: "Menu retrieved successfully",
    data: {
      id: 880557,
      name: "Fried Rice",
      price: 180000,
      in_stock: true,
      is_active: true,
      modifiers: [
        {
          id: 5844769,
          name: "Size",
          minimum_selection: 1,
          maximum_selection: 1,
          maximum_free_selection: 0,
          has_quantity: true,
          items: [
            { id: 4294037, name: "Regular", price: 0, in_stock: true, is_active: true },
            { id: 5751861, name: "Large", price: 60000, in_stock: true, is_active: true },
            { id: 5751862, name: "Jumbo", price: 160000, in_stock: false, is_active: true },
          ],
        },
        {
          id: 5844771,
          name: "Packaging",
          minimum_selection: 1,
          maximum_selection: 1,
          maximum_free_selection: 0,
          has_quantity: true,
          items: [{ id: 4366226, name: "Take-away pack (1,000ml with lid)", price: 40000, in_stock: true, is_active: true }],
        },
      ],
      ...overrides,
    },
  });

const PACK_A = "pack-08dad536-543d-54dd-86db-961e345f7171";
const PACK_B = "pack-6b8c66fb-8bcc-5d34-bd34-10f6fc0e5c0d";

const packRows = (pack: string, ids: [number, number, number]) => [
  { id: ids[0], item_id: 880557, name: "Fried Rice", type: "menu", quantity: 1, price_per_quantity: 180000, discount_price: null, group_name: null, menu_group_id: null, pack_reference: pack, pack_type: "modifier", added_by: "redacted" },
  { id: ids[1], item_id: 4366226, name: "Take-away pack (1,000ml with lid)", type: "group", quantity: 1, price_per_quantity: 40000, group_name: "Packaging", menu_group_id: 5844771, pack_reference: pack, pack_type: "modifier" },
  { id: ids[2], item_id: 4294037, name: "Fried Rice (Regular)", type: "group", quantity: 1, price_per_quantity: 0, group_name: "Size", menu_group_id: 5844769, pack_reference: pack, pack_type: "modifier" },
];

const cartData = (rows: unknown[], totalPrice: number) => ({
  id: 30725140,
  vendor_id: 102555,
  source: "web",
  app_version: "3.0.7",
  status: "active",
  is_active: true,
  type: "single",
  currency: "NGN",
  total_price: totalPrice,
  bag_quantity: 0,
  is_valid: true,
  current_pack_reference: null,
  validation_result: [],
  user_id: "redacted-user",
  address_id: "redacted-address",
  address: { line: "redacted" },
  customer_delivery_note: "redacted note",
  vendor: { id: 102555, name: "Chicken Republic - Opebi", slug: "cr-opebi" },
  created_at: "2026-10-20T09:51:59.000Z",
  updated_at: "2026-10-20T09:58:08.000Z",
  cart_items: rows,
});

const cartWith = (rows: unknown[], totalPrice: number) => () =>
  Response.json({ status: "success", message: "Active cart fetched successfully", data: cartData(rows, totalPrice) });

const noCart = () =>
  Response.json({ status: "success", message: "No active cart found for this vendor", data: {} });

const friedRiceRequest = {
  restaurant_id: 102555,
  address_id: ADDRESS_ID,
  menu_item_id: 880557,
  modifiers: [
    { group_id: 5844769, option_id: 4294037 },
    { group_id: 5844771, option_id: 4366226 },
  ],
};

const expectedWriteBody = {
  source: "web",
  app_version: "2.0.0",
  class: "delivery",
  vendor_id: 102555,
  items: [
    {
      item_id: 880557,
      quantity: 1,
      type: "menu",
      modifiers: [
        { id: 4294037, quantity: 1, menu_group_id: 5844769 },
        { id: 4366226, quantity: 1, menu_group_id: 5844771 },
      ],
    },
  ],
  address_id: ADDRESS_ID,
};

const scriptAddFlow = (before: Handler, write: [string, Handler], after: Handler) => {
  route("GET /customer/address", addressList);
  route("GET /customer/vendor/102555/menu/880557", friedRiceDetail());
  route("GET /customer/cart/vendor/102555", before, after);
  route(write[0], write[1]);
};

describe("cart tools", () => {
  test("are registered on the ChowBot server", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const byName = (name: string) => tools.find((t: { name: string }) => t.name === name);

    expect(byName("list_carts").annotations.readOnlyHint).toBe(true);
    expect(byName("get_cart").annotations.readOnlyHint).toBe(true);
    expect(byName("add_to_cart").annotations.readOnlyHint).toBe(false);
    expect(byName("add_to_cart").inputSchema.required).toEqual(
      expect.arrayContaining(["restaurant_id", "address_id", "menu_item_id"]),
    );
  });

  test.each([
    ["list_carts", {}],
    ["get_cart", { restaurant_id: 102555 }],
    ["add_to_cart", friedRiceRequest],
  ])("%s refuses to run without a per-user session", async (tool, args) => {
    const result = await callTool(serverFor(), tool, args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });

  test.each([
    ["list_carts", {}],
    ["get_cart", { restaurant_id: 102555 }],
    ["add_to_cart", friedRiceRequest],
  ])("%s asks the user to sign in without contacting Chowdeck", async (tool, args) => {
    const result = await callTool(serverFor(await sessionWith({ guestId: "guest-1" })), tool, args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("not signed in to Chowdeck");
    expect(received).toHaveLength(0);
  });
});

describe("get_cart", () => {
  test("reports that no cart exists for the restaurant", async () => {
    route("GET /customer/cart/vendor/102555", noCart);

    const result = await callTool(serverFor(await signedIn()), "get_cart", { restaurant_id: 102555 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ restaurant_id: 102555, exists: false });
    expect(received[0]!.authorization).toBe("Bearer secret-token-alice");
  });

  test("groups rows into packs and leaves out private fields", async () => {
    route("GET /customer/cart/vendor/102555", cartWith(packRows(PACK_A, [130089670, 130089671, 130089672]), 220000));

    const result = await callTool(serverFor(await signedIn()), "get_cart", { restaurant_id: 102555 });
    const text = textOf(result);

    expect(JSON.parse(text)).toEqual({
      restaurant_id: 102555,
      exists: true,
      cart: {
        id: 30725140,
        vendor_id: 102555,
        vendor_name: "Chicken Republic - Opebi",
        total_price: 220000,
        currency: "NGN",
        is_valid: true,
        status: "active",
        type: "single",
        created_at: "2026-10-20T09:51:59.000Z",
        updated_at: "2026-10-20T09:58:08.000Z",
        validation_issues: [],
        packs: [
          {
            pack_reference: PACK_A,
            rows: [
              { cart_item_id: 130089670, item_id: 880557, name: "Fried Rice", type: "menu", quantity: 1, price_per_quantity: 180000, discount_price: null, group_name: null, menu_group_id: null },
              { cart_item_id: 130089671, item_id: 4366226, name: "Take-away pack (1,000ml with lid)", type: "group", quantity: 1, price_per_quantity: 40000, group_name: "Packaging", menu_group_id: 5844771 },
              { cart_item_id: 130089672, item_id: 4294037, name: "Fried Rice (Regular)", type: "group", quantity: 1, price_per_quantity: 0, group_name: "Size", menu_group_id: 5844769 },
            ],
          },
        ],
      },
    });
    for (const secret of ["redacted-user", "redacted-address", "redacted note", "secret-token-alice"]) {
      expect(text).not.toContain(secret);
    }
  });

  test("passes through Chowdeck's validation issues for a stale cart", async () => {
    route("GET /customer/cart/vendor/102555", () =>
      Response.json({
        status: "success",
        data: {
          ...cartData(packRows(PACK_A, [1, 2, 3]), 220000),
          is_valid: false,
          validation_result: [
            {
              pack_id: 1,
              pack_reference: PACK_A,
              issues: [
                { type: "group", menu_id: 880557, group_id: 5844769, group_name: "Size", code: "REQUIRED_GROUP_MISSING", selection_count: 0, selections_required: 1, action: ["ADD_ITEM"] },
              ],
            },
          ],
        },
      }),
    );

    const result = await callTool(serverFor(await signedIn()), "get_cart", { restaurant_id: 102555 });

    expect(JSON.parse(textOf(result)).cart).toMatchObject({
      is_valid: false,
      validation_issues: [
        { pack_reference: PACK_A, code: "REQUIRED_GROUP_MISSING", type: "group", menu_id: 880557, group_id: 5844769, group_name: "Size", selection_count: 0, selections_required: 1 },
      ],
    });
  });

  test.each([
    ["data is missing", { status: "success" }],
    ["cart_items is missing", { data: { id: 1, vendor_id: 102555 } }],
    ["a row has no item_id", { data: { ...cartData([{ id: 9, pack_reference: PACK_A }], 0) } }],
    ["the cart belongs to another restaurant", { data: { ...cartData([], 0), vendor_id: 102556 } }],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    route("GET /customer/cart/vendor/102555", () => Response.json(body));

    const result = await callTool(serverFor(await signedIn()), "get_cart", { restaurant_id: 102555 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to get cart: GET /customer/cart/vendor/102555 returned an unexpected response shape",
    );
  });

  test("reports an upstream failure as a tool error", async () => {
    route("GET /customer/cart/vendor/102555", () =>
      Response.json({ status: "failed", message: "Unauthenticated" }, { status: 401 }),
    );

    const result = await callTool(serverFor(await signedIn()), "get_cart", { restaurant_id: 102555 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to get cart: GET /customer/cart/vendor/102555 failed with status 401: Unauthenticated",
    );
  });
});

describe("list_carts", () => {
  test("summarizes every active cart", async () => {
    route("GET /customer/cart", () =>
      Response.json({
        status: "success",
        message: "Carts fetched successfully",
        data: [
          cartData(packRows(PACK_A, [1, 2, 3]), 220000),
          { ...cartData(packRows(PACK_B, [4, 5, 6]), 825000), id: 26876618, vendor_id: 102556, is_valid: false },
        ],
      }),
    );

    const result = await callTool(serverFor(await signedIn()), "list_carts", {});

    expect(JSON.parse(textOf(result))).toEqual({
      returned: 2,
      carts: [
        expect.objectContaining({ id: 30725140, vendor_id: 102555, total_price: 220000, pack_count: 1, row_count: 3 }),
        expect.objectContaining({ id: 26876618, vendor_id: 102556, total_price: 825000, is_valid: false, pack_count: 1, row_count: 3 }),
      ],
    });
  });

  test("returns an empty list when the user has no carts", async () => {
    route("GET /customer/cart", () => Response.json({ status: "success", data: [] }));

    const result = await callTool(serverFor(await signedIn()), "list_carts", {});

    expect(JSON.parse(textOf(result))).toEqual({ returned: 0, carts: [] });
  });

  test.each([
    ["data is not a list", { data: {} }],
    ["a cart is malformed", { data: [{ id: 1 }] }],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    route("GET /customer/cart", () => Response.json(body));

    const result = await callTool(serverFor(await signedIn()), "list_carts", {});

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to list carts: GET /customer/cart returned an unexpected response shape");
  });
});

describe("add_to_cart", () => {
  test("creates a cart when none exists, then re-reads it", async () => {
    scriptAddFlow(
      noCart,
      ["POST /customer/cart", () => Response.json({ status: "success", message: "Cart created successfully", data: { id: 30725140 } })],
      cartWith(packRows(PACK_A, [130089670, 130089671, 130089672]), 220000),
    );

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /customer/address",
      "GET /customer/vendor/102555/menu/880557",
      "GET /customer/cart/vendor/102555",
      "POST /customer/cart",
      "GET /customer/cart/vendor/102555",
    ]);
    expect(received.every((r) => r.authorization === "Bearer secret-token-alice")).toBe(true);
    expect(writes()[0]!.body).toEqual(expectedWriteBody);

    const parsed = JSON.parse(textOf(result));
    expect(parsed).toMatchObject({
      created_cart: true,
      added: { menu_item_id: 880557, quantity: 1, modifiers: 2 },
      cart: { id: 30725140, total_price: 220000 },
    });
    expect(parsed.cart.packs).toHaveLength(1);
  });

  test("adds a new pack to an existing cart through the vendor path", async () => {
    const packA = packRows(PACK_A, [130089670, 130089671, 130089672]);
    scriptAddFlow(
      cartWith(packA, 220000),
      ["POST /customer/cart/vendor/102555", () => Response.json({ status: "success", message: "Cart item(s) updated successfully" })],
      cartWith([...packA, ...packRows(PACK_B, [130093222, 130093223, 130093221])], 440000),
    );

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);
    const parsed = JSON.parse(textOf(result));

    expect(writes().map((r) => r.path)).toEqual(["/customer/cart/vendor/102555"]);
    expect(writes()[0]!.body).toEqual(expectedWriteBody);
    expect(parsed.created_cart).toBe(false);
    expect(parsed.cart.total_price).toBe(440000);
    expect(parsed.cart.packs.map((p: { pack_reference: string }) => p.pack_reference)).toEqual([PACK_A, PACK_B]);
  });

  test("sends the requested item quantity without changing modifier quantities", async () => {
    scriptAddFlow(
      noCart,
      ["POST /customer/cart", () => Response.json({ status: "success", data: {} })],
      cartWith(packRows(PACK_A, [1, 2, 3]), 440000),
    );

    await callTool(serverFor(await signedIn()), "add_to_cart", { ...friedRiceRequest, quantity: 2 });

    expect(writes()[0]!.body).toMatchObject({
      items: [{ item_id: 880557, quantity: 2, modifiers: [{ quantity: 1 }, { quantity: 1 }] }],
    });
  });

  test.each([
    ["a required group is missing", [{ group_id: 5844769, option_id: 4294037 }], 'option group "Packaging" (5844771) requires at least 1 selection(s)'],
    ["a group gets too many options", [...friedRiceRequest.modifiers, { group_id: 5844769, option_id: 5751861 }], 'option group "Size" (5844769) allows at most 1 selection(s)'],
    ["an option is chosen twice", [...friedRiceRequest.modifiers, { group_id: 5844769, option_id: 4294037 }], "option 4294037 is selected more than once"],
    ["a group does not belong to the item", [{ group_id: 999, option_id: 4294037 }], "option group 999 does not belong to this menu item"],
    ["an option is not in its group", [{ group_id: 5844769, option_id: 4366226 }, { group_id: 5844771, option_id: 4366226 }], "option 4366226 does not belong to option group 5844769"],
    ["an option is out of stock", [{ group_id: 5844769, option_id: 5751862 }, { group_id: 5844771, option_id: 4366226 }], "option 5751862 is not currently available"],
  ])("refuses to write when %s", async (_, modifiers, message) => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], noCart);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", { ...friedRiceRequest, modifiers });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`Failed to add to cart: ${message}`);
    expect(writes()).toHaveLength(0);
  });

  test("refuses an item that is not currently available", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], noCart);
    route("GET /customer/vendor/102555/menu/880557", friedRiceDetail({ in_stock: false }));

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(textOf(result)).toBe("Failed to add to cart: this menu item is not currently available");
    expect(writes()).toHaveLength(0);
  });

  test("refuses an address that is not one of the user's saved addresses", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], noCart);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", { ...friedRiceRequest, address_id: 98765 });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to add to cart: address_id is not one of your saved delivery addresses; call list_addresses to choose one",
    );
    expect(textOf(result)).not.toContain("98765");
    expect(writes()).toHaveLength(0);
  });

  test("reports a missing menu item without writing", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], noCart);
    route("GET /customer/vendor/102555/menu/880557", () =>
      Response.json({ status: "failed", message: "Menu not found" }, { status: 404 }),
    );

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(textOf(result)).toBe(
      "Failed to add to cart: GET /customer/vendor/102555/menu/880557 failed with status 404: Menu not found",
    );
    expect(writes()).toHaveLength(0);
  });

  test("reports a rejected write and does not claim success", async () => {
    scriptAddFlow(
      noCart,
      ["POST /customer/cart", () => Response.json({ status: "failed", message: "Vendor is closed" }, { status: 422 })],
      noCart,
    );

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to add to cart: POST /customer/cart failed with status 422: Vendor is closed",
    );
  });

  test("asks the caller to check the cart when a write reply is not a success", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "pending" })], noCart);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to add to cart: POST /customer/cart returned an unexpected response; check the cart with get_cart before retrying",
    );
  });

  test("reports a re-read that finds no cart after a successful write", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], noCart);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to add to cart: GET /customer/cart/vendor/102555 returned an unexpected response shape",
    );
  });

  test.each([
    [{ ...friedRiceRequest, address_id: undefined }, "address_id"],
    [{ ...friedRiceRequest, quantity: 0 }, "quantity"],
    [{ ...friedRiceRequest, quantity: 21 }, "quantity"],
    [{ ...friedRiceRequest, menu_item_id: "880557" }, "menu_item_id"],
    [{ ...friedRiceRequest, modifiers: [{ group_id: 5844769 }] }, "option_id"],
  ])("rejects invalid input %p before contacting Chowdeck", async (args, field) => {
    const result = await callTool(serverFor(await signedIn()), "add_to_cart", args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
    expect(textOf(result)).toContain(field);
    expect(received).toHaveLength(0);
  });

  test("keeps each user's requests on their own token", async () => {
    const after = cartWith(packRows(PACK_A, [1, 2, 3]), 220000);
    for (const token of ["secret-token-alice", "secret-token-bob"]) {
      scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], after);
      route("GET /customer/cart/vendor/102555", noCart, after);
      await callTool(serverFor(await sessionWith({ token })), "add_to_cart", friedRiceRequest);
    }

    const tokensByRequest = received.map((r) => r.authorization);
    expect(tokensByRequest.slice(0, 5).every((t) => t === "Bearer secret-token-alice")).toBe(true);
    expect(tokensByRequest.slice(5).every((t) => t === "Bearer secret-token-bob")).toBe(true);
    expect(tokensByRequest).toHaveLength(10);
  });
});
