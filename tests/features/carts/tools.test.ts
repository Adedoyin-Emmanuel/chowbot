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
  contentType: string | null;
  body: unknown;
};

type Handler = () => Response | Promise<Response>;

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
        contentType: req.headers.get("content-type"),
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

const serverFor =
  (session?: UserSession, timeoutMs = 1000, baseUrl?: string) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerCartTools(
    server,
    session,
    new ChowdeckClient({ baseUrl: baseUrl ?? upstream.url.origin, timeoutMs }),
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
    ["duplicate_cart_pack", { restaurant_id: 102555, pack_reference: "pack-x" }],
    ["remove_cart_pack", { restaurant_id: 102555, pack_reference: "pack-x" }],
    ["clear_cart", { restaurant_id: 102555 }],
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
    ["duplicate_cart_pack", { restaurant_id: 102555, pack_reference: "pack-x" }],
    ["remove_cart_pack", { restaurant_id: 102555, pack_reference: "pack-x" }],
    ["clear_cart", { restaurant_id: 102555 }],
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

describe("duplicate_cart_pack", () => {
  /*
   * From the capture's duplicate step: pack B was copied into pack C with
   * new row IDs, and total_price went from 220000 to 440000.
   */
  const PACK_C = "pack-47d71e72-3fac-5da6-a42f-e01cf5e3fd01";
  const DUPLICATE_PATH = `/customer/cart/30725140/pack/${PACK_B}/duplicate`;
  const packB = packRows(PACK_B, [130093222, 130093223, 130093221]);
  const packC = packRows(PACK_C, [130109597, 130109598, 130109599]);
  const duplicated = () =>
    Response.json({ status: "success", message: "Pack duplicated successfully" });

  const scriptDuplicate = (write: Handler, after: Handler) => {
    route("GET /customer/cart/vendor/102555", cartWith(packB, 220000), after);
    route(`POST ${DUPLICATE_PATH}`, write);
  };

  const duplicate = async (args: Record<string, unknown> = {}, session?: UserSession) =>
    callTool(serverFor(session ?? (await signedIn())), "duplicate_cart_pack", {
      restaurant_id: 102555,
      pack_reference: PACK_B,
      ...args,
    });

  test("duplicates a pack with a bodiless POST and returns the re-read cart", async () => {
    scriptDuplicate(duplicated, cartWith([...packB, ...packC], 440000));

    const result = await duplicate();

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /customer/cart/vendor/102555",
      `POST ${DUPLICATE_PATH}`,
      "GET /customer/cart/vendor/102555",
    ]);
    expect(writes()[0]!.body).toBeUndefined();
    expect(writes()[0]!.contentType).toBeNull();
    expect(received.every((r) => r.authorization === "Bearer secret-token-alice")).toBe(true);

    const parsed = JSON.parse(textOf(result));
    expect(parsed).toMatchObject({
      duplicated_pack_reference: PACK_B,
      new_pack_reference: PACK_C,
      cart: { id: 30725140, total_price: 440000 },
    });
    expect(parsed.cart.packs.map((p: { pack_reference: string }) => p.pack_reference)).toEqual([
      PACK_B,
      PACK_C,
    ]);
  });

  test("takes the cart ID from the user's cart, not from the caller", async () => {
    scriptDuplicate(duplicated, cartWith([...packB, ...packC], 440000));

    await duplicate({ cart_id: 999 });

    expect(writes().map((r) => r.path)).toEqual([DUPLICATE_PATH]);
  });

  test("refuses when there is no cart for the restaurant", async () => {
    route("GET /customer/cart/vendor/102555", noCart);

    const result = await duplicate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to duplicate cart pack: there is no cart for this restaurant",
    );
    expect(writes()).toHaveLength(0);
  });

  test("refuses a pack reference that is not in the current cart", async () => {
    scriptDuplicate(duplicated, cartWith(packB, 220000));

    const result = await duplicate({ pack_reference: PACK_A });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to duplicate cart pack: pack_reference is not in your current cart for this restaurant; call get_cart to see its packs",
    );
    expect(writes()).toHaveLength(0);
  });

  test("reports a rejected duplication without re-reading or retrying", async () => {
    scriptDuplicate(
      () => Response.json({ status: "failed", message: "Vendor is closed" }, { status: 422 }),
      cartWith(packB, 220000),
    );

    const result = await duplicate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Failed to duplicate cart pack: POST ${DUPLICATE_PATH} failed with status 422: Vendor is closed`,
    );
    expect(writes()).toHaveLength(1);
    expect(received).toHaveLength(2);
  });

  test("treats a server error as an uncertain outcome", async () => {
    scriptDuplicate(
      () => Response.json({ message: "Server Error" }, { status: 503 }),
      cartWith(packB, 220000),
    );

    const result = await duplicate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Failed to duplicate cart pack: POST ${DUPLICATE_PATH} failed with status 503: Server Error; the pack may or may not have been duplicated; check the cart with get_cart before retrying`,
    );
    expect(writes()).toHaveLength(1);
  });

  test.each([
    ["a non-success status", { status: "pending" }],
    ["no status", { message: "Pack duplicated successfully" }],
  ])("does not claim success when the reply has %s", async (_, body) => {
    scriptDuplicate(() => Response.json(body), cartWith([...packB, ...packC], 440000));

    const result = await duplicate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Failed to duplicate cart pack: POST ${DUPLICATE_PATH} returned an unexpected response; check the cart with get_cart before retrying`,
    );
  });

  test("reports a failed re-read after a successful duplication", async () => {
    scriptDuplicate(duplicated, () =>
      Response.json({ message: "Server Error" }, { status: 500 }),
    );

    const result = await duplicate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to duplicate cart pack: Chowdeck reported the pack duplicated, but re-reading the cart failed (GET /customer/cart/vendor/102555 failed with status 500: Server Error); check the cart with get_cart before retrying",
    );
    expect(writes()).toHaveLength(1);
  });

  test.each([
    ["shows no new pack", () => cartWith(packB, 220000)],
    ["shows two new copies", () =>
      cartWith([...packB, ...packC, ...packRows("pack-other", [7, 8, 9])], 660000)],
    ["no longer has the original pack", () => cartWith(packC, 220000)],
    ["has a new pack with different contents", () =>
      cartWith([...packB, ...packRows(PACK_C, [1, 2, 3]).slice(0, 2)], 400000)],
    ["finds no cart", () => noCart],
  ])("does not confirm the copy when the re-read cart %s", async (_, after) => {
    scriptDuplicate(duplicated, after());

    const result = await duplicate();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to duplicate cart pack: Chowdeck reported the pack duplicated, but the re-read cart does not show exactly one new copy of it; check the cart with get_cart before retrying",
    );
  });

  test("reports a malformed cart before writing anything", async () => {
    route("GET /customer/cart/vendor/102555", () => Response.json({ status: "success" }));

    const result = await duplicate();

    expect(textOf(result)).toBe(
      "Failed to duplicate cart pack: GET /customer/cart/vendor/102555 returned an unexpected response shape",
    );
    expect(writes()).toHaveLength(0);
  });

  test.each([
    [{ pack_reference: "" }, "pack_reference"],
    [{ pack_reference: "../../order" }, "pack_reference"],
    [{ pack_reference: "pack x" }, "pack_reference"],
    [{ restaurant_id: 0 }, "restaurant_id"],
  ])("rejects invalid input %p before contacting Chowdeck", async (args, field) => {
    const result = await duplicate(args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
    expect(textOf(result)).toContain(field);
    expect(received).toHaveLength(0);
  });

  test("never lets one user act on another user's pack", async () => {
    route("GET /customer/cart/vendor/102555", noCart);

    const bob = await sessionWith({ token: "secret-token-bob" });
    const result = await duplicate({}, bob);

    expect(textOf(result)).toBe(
      "Failed to duplicate cart pack: there is no cart for this restaurant",
    );
    expect(received.map((r) => r.authorization)).toEqual(["Bearer secret-token-bob"]);
    expect(writes()).toHaveLength(0);
  });

  test("keeps the result free of tokens and private cart fields", async () => {
    scriptDuplicate(duplicated, cartWith([...packB, ...packC], 440000));

    const text = textOf(await duplicate());

    for (const secret of ["secret-token-alice", "redacted-user", "redacted-address", "redacted note"]) {
      expect(text).not.toContain(secret);
    }
  });
});

const deletes = () => received.filter((r) => r.method === "DELETE");
const slow = (response: () => Response) => async () => {
  await Bun.sleep(300);
  return response();
};

describe("remove_cart_pack", () => {
  /*
   * From the capture's single-pack removal: cart 30742921 held Pack 1 and
   * Pack 2; deleting Pack 2 left Pack 1 byte-identical and total_price at
   * 220000.
   */
  const CART_ID = 30742921;
  const PACK_1 = "pack-2a74396b-8d91-54d8-97ae-912b71e15ec5";
  const PACK_2 = "pack-1d4df86b-bfd3-5c8b-b089-c7122f661625";
  const REMOVE_PATH = `/customer/cart/${CART_ID}/pack/${PACK_2}`;
  const pack1 = packRows(PACK_1, [130161037, 130161039, 130161038]);
  const pack2 = packRows(PACK_2, [130162373, 130162375, 130162374]);
  const cartOf = (rows: unknown[], totalPrice: number) => () =>
    Response.json({
      status: "success",
      message: "Active cart fetched successfully",
      data: { ...cartData(rows, totalPrice), id: CART_ID },
    });
  const deleted = () =>
    Response.json({ status: "success", message: "Pack deleted successfully", data: {} });

  const scriptRemove = (write: Handler, after: Handler) => {
    route("GET /customer/cart/vendor/102555", cartOf([...pack1, ...pack2], 440000), after);
    route(`DELETE ${REMOVE_PATH}`, write);
  };

  const remove = async (
    args: Record<string, unknown> = {},
    session?: UserSession,
    timeoutMs?: number,
  ) =>
    callTool(serverFor(session ?? (await signedIn()), timeoutMs), "remove_cart_pack", {
      restaurant_id: 102555,
      pack_reference: PACK_2,
      ...args,
    });

  const UNVERIFIED =
    "Failed to remove cart pack: Chowdeck reported the pack removed, but the re-read cart does not show only that pack gone; check the cart with get_cart before retrying";

  test("removes one pack with a bodiless DELETE and returns the re-read cart", async () => {
    scriptRemove(deleted, cartOf(pack1, 220000));

    const result = await remove();

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /customer/cart/vendor/102555",
      `DELETE ${REMOVE_PATH}`,
      "GET /customer/cart/vendor/102555",
    ]);
    expect(deletes()[0]!.body).toBeUndefined();
    expect(deletes()[0]!.contentType).toBeNull();
    expect(received.every((r) => r.authorization === "Bearer secret-token-alice")).toBe(true);

    const parsed = JSON.parse(textOf(result));
    expect(parsed).toMatchObject({
      restaurant_id: 102555,
      removed_pack_reference: PACK_2,
      cart_exists: true,
      cart: { id: CART_ID, total_price: 220000 },
    });
    expect(parsed.cart.packs).toHaveLength(1);
    expect(parsed.cart.packs[0].pack_reference).toBe(PACK_1);
    expect(parsed.cart.packs[0].rows.map((r: { cart_item_id: number }) => r.cart_item_id)).toEqual([
      130161037, 130161039, 130161038,
    ]);
  });

  test("takes the cart ID from the user's cart, not from the caller", async () => {
    scriptRemove(deleted, cartOf(pack1, 220000));

    await remove({ cart_id: 999 });

    expect(deletes().map((r) => r.path)).toEqual([REMOVE_PATH]);
  });

  test("refuses when there is no cart for the restaurant", async () => {
    route("GET /customer/cart/vendor/102555", noCart);

    const result = await remove();

    expect(textOf(result)).toBe("Failed to remove cart pack: there is no cart for this restaurant");
    expect(deletes()).toHaveLength(0);
  });

  test("refuses a pack reference that is not in the current cart", async () => {
    scriptRemove(deleted, cartOf(pack1, 220000));

    const result = await remove({ pack_reference: PACK_A });

    expect(textOf(result)).toBe(
      "Failed to remove cart pack: pack_reference is not in your current cart for this restaurant; call get_cart to see its packs",
    );
    expect(deletes()).toHaveLength(0);
  });

  test.each([
    ["no cart remains", noCart, false],
    ["an empty cart remains", cartOf([], 0), true],
  ])("accepts removing the last pack when %s", async (_, after, cartExists) => {
    route("GET /customer/cart/vendor/102555", cartOf(pack2, 220000), after);
    route(`DELETE ${REMOVE_PATH}`, deleted);

    const result = await remove();

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({
      removed_pack_reference: PACK_2,
      cart_exists: cartExists,
    });
  });

  test.each([
    ["still has the removed pack", () => cartOf([...pack1, ...pack2], 440000)],
    ["shows a remaining pack with changed contents", () =>
      cartOf(pack1.map((row) => (row.type === "menu" ? { ...row, quantity: 2 } : row)), 400000)],
    ["shows a remaining pack with new row IDs", () =>
      cartOf(packRows(PACK_1, [1, 2, 3]), 220000)],
    ["no longer has the remaining pack", () => cartOf([], 0)],
    ["finds no cart although a pack should remain", () => noCart],
    ["has an extra pack", () => cartOf([...pack1, ...packRows(PACK_B, [4, 5, 6])], 440000)],
  ])("does not confirm the removal when the re-read cart %s", async (_, after) => {
    scriptRemove(deleted, after());

    const result = await remove();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(UNVERIFIED);
    expect(deletes()).toHaveLength(1);
  });

  test("reports a rejected removal without re-reading or retrying", async () => {
    scriptRemove(
      () => Response.json({ status: "failed", message: "Pack not found" }, { status: 404 }),
      cartOf(pack1, 220000),
    );

    const result = await remove();

    expect(textOf(result)).toBe(
      `Failed to remove cart pack: DELETE ${REMOVE_PATH} failed with status 404: Pack not found`,
    );
    expect(deletes()).toHaveLength(1);
    expect(received).toHaveLength(2);
  });

  test("treats a server error as an uncertain outcome", async () => {
    scriptRemove(() => Response.json({ message: "Server Error" }, { status: 502 }), cartOf(pack1, 220000));

    const result = await remove();

    expect(textOf(result)).toBe(
      `Failed to remove cart pack: DELETE ${REMOVE_PATH} failed with status 502: Server Error; the pack may or may not have been removed; check the cart with get_cart before retrying`,
    );
    expect(deletes()).toHaveLength(1);
  });

  test("treats a timeout as an uncertain outcome and does not retry", async () => {
    scriptRemove(slow(deleted), cartOf(pack1, 220000));

    const result = await remove({}, undefined, 100);

    expect(textOf(result)).toBe(
      `Failed to remove cart pack: DELETE ${REMOVE_PATH} timed out after 100ms; the pack may or may not have been removed; check the cart with get_cart before retrying`,
    );
    expect(deletes()).toHaveLength(1);
  });

  test.each([
    ["a non-success status", { status: "failed" }],
    ["no status", { message: "Pack deleted successfully" }],
  ])("does not claim success when the reply has %s", async (_, body) => {
    scriptRemove(() => Response.json(body), cartOf(pack1, 220000));

    const result = await remove();

    expect(textOf(result)).toBe(
      `Failed to remove cart pack: DELETE ${REMOVE_PATH} returned an unexpected response; check the cart with get_cart before retrying`,
    );
  });

  test("reports a failed re-read after a successful removal", async () => {
    scriptRemove(deleted, () => Response.json({ status: "success" }));

    const result = await remove();

    expect(textOf(result)).toBe(
      "Failed to remove cart pack: Chowdeck reported the pack removed, but re-reading the cart failed (GET /customer/cart/vendor/102555 returned an unexpected response shape); check the cart with get_cart before retrying",
    );
    expect(deletes()).toHaveLength(1);
  });

  test("rejects an unsafe pack reference before contacting Chowdeck", async () => {
    const result = await remove({ pack_reference: "../../order" });

    expect(textOf(result)).toContain("Input validation error");
    expect(received).toHaveLength(0);
  });

  test("never lets one user remove another user's pack", async () => {
    route("GET /customer/cart/vendor/102555", cartOf(pack1, 220000));

    const result = await remove({}, await sessionWith({ token: "secret-token-bob" }));

    expect(textOf(result)).toContain("pack_reference is not in your current cart");
    expect(received.map((r) => r.authorization)).toEqual(["Bearer secret-token-bob"]);
    expect(deletes()).toHaveLength(0);
  });

  test("keeps the result free of tokens and private cart fields", async () => {
    scriptRemove(deleted, cartOf(pack1, 220000));

    const text = textOf(await remove());

    for (const secret of ["secret-token-alice", "redacted-user", "redacted-address", "redacted note"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("clear_cart", () => {
  /*
   * From the capture's Clear Cart step: DELETE /customer/cart/30725140, after
   * which vendor 102555 had no cart and vendor 102556's cart 26876618 was
   * untouched.
   */
  const CLEAR_PATH = "/customer/cart/30725140";
  const OTHER_CART_PATH = "/customer/cart/26876618";
  const cleared = () =>
    Response.json({ status: "success", message: "Cart deleted successfully", data: {} });
  const twoPacks = cartWith(
    [...packRows(PACK_A, [1, 2, 3]), ...packRows(PACK_B, [4, 5, 6])],
    440000,
  );

  const scriptClear = (write: Handler, after: Handler) => {
    route("GET /customer/cart/vendor/102555", twoPacks, after);
    route(`DELETE ${CLEAR_PATH}`, write);
  };

  const clear = async (
    args: Record<string, unknown> = {},
    session?: UserSession,
    timeoutMs?: number,
  ) =>
    callTool(serverFor(session ?? (await signedIn()), timeoutMs), "clear_cart", {
      restaurant_id: 102555,
      ...args,
    });

  test("deletes the restaurant's cart with a bodiless DELETE and confirms it is gone", async () => {
    scriptClear(cleared, noCart);

    const result = await clear();

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /customer/cart/vendor/102555",
      `DELETE ${CLEAR_PATH}`,
      "GET /customer/cart/vendor/102555",
    ]);
    expect(deletes()[0]!.body).toBeUndefined();
    expect(deletes()[0]!.contentType).toBeNull();
    expect(received.every((r) => r.authorization === "Bearer secret-token-alice")).toBe(true);
    expect(JSON.parse(textOf(result))).toEqual({
      restaurant_id: 102555,
      cart_existed: true,
      cleared: true,
      removed_packs: 2,
    });
  });

  test("takes the cart ID from the user's cart, not from the caller", async () => {
    scriptClear(cleared, noCart);

    await clear({ cart_id: 26876618 });

    expect(deletes().map((r) => r.path)).toEqual([CLEAR_PATH]);
  });

  test("does nothing when there is no cart for the restaurant", async () => {
    route("GET /customer/cart/vendor/102555", noCart);

    const result = await clear();

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({
      restaurant_id: 102555,
      cart_existed: false,
      cleared: false,
      removed_packs: 0,
    });
    expect(deletes()).toHaveLength(0);
  });

  test("only ever targets the requested restaurant's cart", async () => {
    route(
      "GET /customer/cart/vendor/102556",
      () =>
        Response.json({
          status: "success",
          data: { ...cartData(packRows(PACK_B, [7, 8, 9]), 825000), id: 26876618, vendor_id: 102556 },
        }),
      noCart,
    );
    route(`DELETE ${OTHER_CART_PATH}`, cleared);

    await clear({ restaurant_id: 102556 });

    expect(deletes().map((r) => r.path)).toEqual([OTHER_CART_PATH]);
    expect(received.some((r) => r.path === CLEAR_PATH)).toBe(false);
  });

  test("does not confirm the deletion when a cart is still there", async () => {
    scriptClear(cleared, twoPacks);

    const result = await clear();

    expect(textOf(result)).toBe(
      "Failed to clear cart: Chowdeck reported the cart deleted, but the re-read still shows a cart for this restaurant; check the cart with get_cart before retrying",
    );
    expect(deletes()).toHaveLength(1);
  });

  test("reports a rejected deletion without re-reading or retrying", async () => {
    scriptClear(
      () => Response.json({ status: "failed", message: "Cart not found" }, { status: 404 }),
      noCart,
    );

    const result = await clear();

    expect(textOf(result)).toBe(
      `Failed to clear cart: DELETE ${CLEAR_PATH} failed with status 404: Cart not found`,
    );
    expect(received).toHaveLength(2);
  });

  test("treats a server error as an uncertain outcome", async () => {
    scriptClear(() => Response.json({ message: "Server Error" }, { status: 500 }), noCart);

    const result = await clear();

    expect(textOf(result)).toBe(
      `Failed to clear cart: DELETE ${CLEAR_PATH} failed with status 500: Server Error; the cart may or may not have been deleted; check the cart with get_cart before retrying`,
    );
    expect(deletes()).toHaveLength(1);
  });

  test("treats a timeout as an uncertain outcome and does not retry", async () => {
    scriptClear(slow(cleared), noCart);

    const result = await clear({}, undefined, 100);

    expect(textOf(result)).toBe(
      `Failed to clear cart: DELETE ${CLEAR_PATH} timed out after 100ms; the cart may or may not have been deleted; check the cart with get_cart before retrying`,
    );
    expect(deletes()).toHaveLength(1);
  });

  test("does not claim success when the reply is not a success envelope", async () => {
    scriptClear(() => Response.json({ status: "pending" }), noCart);

    const result = await clear();

    expect(textOf(result)).toBe(
      `Failed to clear cart: DELETE ${CLEAR_PATH} returned an unexpected response; check the cart with get_cart before retrying`,
    );
  });

  test("reports a failed re-read after a successful deletion", async () => {
    scriptClear(cleared, () => Response.json({ message: "Server Error" }, { status: 500 }));

    const result = await clear();

    expect(textOf(result)).toBe(
      "Failed to clear cart: Chowdeck reported the cart deleted, but re-reading the cart failed (GET /customer/cart/vendor/102555 failed with status 500: Server Error); check the cart with get_cart before retrying",
    );
    expect(deletes()).toHaveLength(1);
  });

  test("uses each user's own token", async () => {
    route("GET /customer/cart/vendor/102555", noCart);

    await clear({}, await sessionWith({ token: "secret-token-bob" }));

    expect(received.map((r) => r.authorization)).toEqual(["Bearer secret-token-bob"]);
    expect(deletes()).toHaveLength(0);
  });

  test("keeps the result free of tokens and private cart fields", async () => {
    scriptClear(cleared, noCart);

    const text = textOf(await clear());

    for (const secret of ["secret-token-alice", "redacted-user", "redacted-address", "redacted note", "30725140"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("add_to_cart uncertain outcomes", () => {
  const CHECK = "check the cart with get_cart before retrying";
  const MAY_HAVE_ADDED = "the item may or may not have been added";
  const afterAdd = cartWith(packRows(PACK_A, [1, 2, 3]), 220000);

  /*
   * Every failure must leave exactly one write and no re-read: address,
   * menu item and cart are read, then the single POST.
   */
  const expectSingleWriteNoReread = () => {
    expect(writes()).toHaveLength(1);
    expect(received).toHaveLength(4);
  };

  test("treats a timeout as an uncertain outcome", async () => {
    scriptAddFlow(
      noCart,
      ["POST /customer/cart", slow(() => Response.json({ status: "success" }))],
      afterAdd,
    );

    const result = await callTool(serverFor(await signedIn(), 100), "add_to_cart", friedRiceRequest);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      `Failed to add to cart: POST /customer/cart timed out after 100ms; ${MAY_HAVE_ADDED}; ${CHECK}`,
    );
    expectSingleWriteNoReread();
  });

  test("treats a dropped connection as an uncertain outcome", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], afterAdd);
    const dropping: Server<undefined> = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        if (req.method !== "POST") {
          return fetch(new URL(path, upstream.url), { headers: req.headers });
        }
        received.push({
          method: req.method,
          path,
          authorization: req.headers.get("authorization"),
          contentType: req.headers.get("content-type"),
          body: JSON.parse(await req.text()),
        });
        dropping.stop(true);
        return new Promise<Response>(() => {});
      },
    });

    const result = await callTool(
      serverFor(await signedIn(), 1000, dropping.url.origin),
      "add_to_cart",
      friedRiceRequest,
    );

    expect(textOf(result)).toBe(
      `Failed to add to cart: POST /customer/cart failed: network error; ${MAY_HAVE_ADDED}; ${CHECK}`,
    );
    expect(writes()[0]!.body).toEqual(expectedWriteBody);
    expectSingleWriteNoReread();
  });

  test.each([
    ["creating a cart", noCart, "POST /customer/cart", 503],
    ["adding to an existing cart", afterAdd, "POST /customer/cart/vendor/102555", 500],
  ])("treats a server error while %s as an uncertain outcome", async (_, before, write, status) => {
    scriptAddFlow(before, [write, () => Response.json({ message: "Server Error" }, { status })], afterAdd);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(textOf(result)).toBe(
      `Failed to add to cart: ${write} failed with status ${status}: Server Error; ${MAY_HAVE_ADDED}; ${CHECK}`,
    );
    expectSingleWriteNoReread();
  });

  test.each([
    ["a non-success status", () => Response.json({ status: "pending" }), "returned an unexpected response"],
    ["no status", () => Response.json({ message: "Cart created successfully" }), "returned an unexpected response"],
    ["an empty body", () => new Response(null, { status: 200 }), "returned an unexpected response"],
    ["a non-JSON body", () => new Response("<html>ok</html>", { status: 200 }), `returned a non-JSON response; ${MAY_HAVE_ADDED}`],
  ])("does not claim success when the reply has %s", async (_, reply, detail) => {
    scriptAddFlow(noCart, ["POST /customer/cart", reply], afterAdd);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(textOf(result)).toBe(`Failed to add to cart: POST /customer/cart ${detail}; ${CHECK}`);
    expectSingleWriteNoReread();
  });

  test("keeps a 4xx as a definite rejection", async () => {
    scriptAddFlow(
      noCart,
      ["POST /customer/cart", () => Response.json({ status: "failed", message: "Vendor is closed" }, { status: 422 })],
      afterAdd,
    );

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(textOf(result)).toBe(
      "Failed to add to cart: POST /customer/cart failed with status 422: Vendor is closed",
    );
    expect(textOf(result)).not.toContain("may or may not");
    expectSingleWriteNoReread();
  });

  test("still adds, re-reads and returns the cart on success", async () => {
    scriptAddFlow(noCart, ["POST /customer/cart", () => Response.json({ status: "success" })], afterAdd);

    const result = await callTool(serverFor(await signedIn()), "add_to_cart", friedRiceRequest);

    expect(result.isError).toBeUndefined();
    expect(writes()[0]!.body).toEqual(expectedWriteBody);
    expect(received).toHaveLength(5);
    expect(JSON.parse(textOf(result))).toMatchObject({
      created_cart: true,
      cart: { id: 30725140, total_price: 220000 },
    });
  });
});
