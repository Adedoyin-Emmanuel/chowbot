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
import { registerCheckoutTools } from "../../../features/checkout/tools";
import type { NewQuote, UserOrderSubmissions } from "../../../lib/order-submissions";

type ReceivedRequest = {
  method: string;
  path: string;
  query: URLSearchParams;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
};

type Handler = () => Response | Promise<Response>;

let upstream: Server<undefined>;
let received: ReceivedRequest[];
let routes: Map<string, Handler[]>;

const route = (key: string, ...handlers: Handler[]) => routes.set(key, handlers);

const record = async (req: Request) => {
  const url = new URL(req.url);
  const text = await req.text();
  received.push({
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    authorization: req.headers.get("authorization"),
    contentType: req.headers.get("content-type"),
    body: text ? JSON.parse(text) : undefined,
  });
  return url.pathname;
};

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = await record(req);
      const queue = routes.get(`${req.method} ${path}`);
      const handler = queue && (queue.length > 1 ? queue.shift() : queue[0]);
      return handler
        ? handler()
        : Response.json({ message: "unexpected request" }, { status: 500 });
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
  (
    session?: UserSession,
    timeoutMs = 1000,
    baseUrl?: string,
    submissions?: UserOrderSubmissions,
  ) =>
  () => {
    const server = new McpServer({ name: "ChowBot", version: "test" });
    registerCheckoutTools(
      server,
      session,
      new ChowdeckClient({ baseUrl: baseUrl ?? upstream.url.origin, timeoutMs }),
      submissions,
    );
    return server;
  };

const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;
const quotePosts = () =>
  received.filter((r) => r.method === "POST" && r.path === "/customer/delivery/amount");
const requestKeys = () => received.map((r) => `${r.method} ${r.path}`);

/*
 * Fixtures follow the sanitized checkout capture (2026-10-20): cart
 * 30742921 at vendor 102555 with two Fried Rice packs (total_price 440000),
 * the successful delivery-fee response, and the payment-methods response.
 * The address ID, the vendor's address_id (source_id) and the fee ID were
 * redacted in the capture, so distinctive test values stand in for them.
 */
const ADDRESS_ID = 918273;
const VENDOR_ADDRESS_ID = 645372;
const FEE_ID = 99887766;
const PACK_1 = "pack-2a74396b-8d91-54d8-97ae-912b71e15ec5";
const PACK_2 = "pack-dc9e6e30-55a3-5456-88f6-715bddd70e2e";

const packRows = (pack: string, ids: [number, number, number]) => [
  { id: ids[0], item_id: 880557, name: "Fried Rice", type: "menu", quantity: 1, price_per_quantity: 180000, group_name: null, menu_group_id: null, pack_reference: pack },
  { id: ids[1], item_id: 4294037, name: "Fried Rice (Regular)", type: "group", quantity: 1, price_per_quantity: 0, group_name: "Size", menu_group_id: 5844769, pack_reference: pack },
  { id: ids[2], item_id: 4366226, name: "Take-away pack (1,000ml with lid)", type: "group", quantity: 1, price_per_quantity: 40000, group_name: "Packaging", menu_group_id: 5844771, pack_reference: pack },
];

const cartData = (overrides: Record<string, unknown> = {}) => ({
  id: 30742921,
  vendor_id: 102555,
  status: "active",
  class: "delivery",
  type: "single",
  currency: "NGN",
  total_price: 440000,
  is_valid: true,
  validation_result: [],
  user_id: "redacted-user",
  address_id: "redacted-cart-address",
  address: { street: "redacted-street" },
  customer_delivery_note: "redacted note",
  vendor: { id: 102555, name: "Chicken Republic - Opebi" },
  cart_items: [
    ...packRows(PACK_1, [130161037, 130161038, 130161039]),
    ...packRows(PACK_2, [130193932, 130193933, 130193934]),
  ],
  ...overrides,
});

const cartResponse = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({ status: "success", message: "Active cart fetched successfully", data: cartData(overrides) });

const noCart = () =>
  Response.json({ status: "success", message: "No active cart found for this vendor", data: {} });

const addressList = (ids = [ADDRESS_ID]) => () =>
  Response.json({
    status: "success",
    data: ids.map((id) => ({ id, pretty_name: "Home", street: "redacted-street", coordinate: "redacted-coordinate" })),
  });

const vendorResponse = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: {
      id: 102555,
      name: "Chicken Republic - Opebi",
      address_id: VENDOR_ADDRESS_ID,
      minimum_order_amount: 250000,
      is_open: true,
      operationally_open: 1,
      current_is_open_state: true,
      is_closed_by_operations: false,
      is_temporarily_unavailable: false,
      offers_delivery: false,
      available_hours: { default: { opening: "0800", closing: "2100" } },
      phone: "redacted-vendor-phone",
      address: { street: "redacted-vendor-street" },
      ...overrides,
    },
  });

const quoteData = (overrides: Record<string, unknown> = {}) => ({
  amount: 70000,
  original_delivery_amount: 70000,
  final_delivery_amount: 70000,
  delivery_price_factor: 1,
  service_amount: 44000,
  original_service_amount: 44000,
  final_service_amount: 44000,
  small_order_amount: 0,
  small_order_reason: null,
  minimum_order_amount: 170589,
  id: FEE_ID,
  vendor_id: 102555,
  safety_fee: 0,
  distance: "redacted-distance",
  service_fee_savings: 8800,
  delivery_fee_savings: 70000,
  total_potential_savings: 78800,
  currency: "NGN",
  additional_order_fees: [
    { label: "Service Fee", amount: 0, value: "10.00", type: "percentage", currency: "NGN", summary: "Service Fee (10.00%)" },
    { label: "VAT", amount: 0, value: 7.5, type: "percentage", currency: "NGN", summary: "VAT (7.5%)" },
    { label: "Service Fee Taxes", amount: 0, value: 0, type: "fixed", currency: "NGN", summary: "Service Fee Taxes (NGN 0.00)" },
    { label: "Service Fee (Tax Free)", amount: 0, value: 0, type: "fixed", currency: "NGN", summary: "Service Fee (Tax Free) (NGN 0.00)" },
  ],
  ...overrides,
});

const quoteResponse = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({ status: "success", message: "Amount computed successfully", data: quoteData(overrides) });

const paymentMethods = () =>
  Response.json({
    status: "success",
    message: "Payment methods retrieved successfully",
    data: [
      { type: "wallet", pretty_name: "Wallet", image_url: "", is_current_active: false, balance: 123456 },
      { type: "online_payment", pretty_name: "Pay online", image_url: "", is_current_active: true },
    ],
  });

const scriptCheckout = (handlers: {
  cart?: Handler;
  addresses?: Handler;
  vendor?: Handler;
  quote?: Handler;
  methods?: Handler;
} = {}) => {
  route("GET /customer/cart/vendor/102555", handlers.cart ?? cartResponse());
  route("GET /customer/address", handlers.addresses ?? addressList());
  route("GET /customer/vendor/102555", handlers.vendor ?? vendorResponse());
  route("POST /customer/delivery/amount", handlers.quote ?? quoteResponse());
  route("GET /customer/payment/methods", handlers.methods ?? paymentMethods);
};

const quote = async (
  args: Record<string, unknown> = {},
  session?: UserSession,
  timeoutMs?: number,
) =>
  callTool(serverFor(session ?? (await signedIn()), timeoutMs), "get_checkout_quote", {
    restaurant_id: 102555,
    address_id: ADDRESS_ID,
    ...args,
  });

const UNCERTAIN =
  "a delivery-fee quote may have been created on Chowdeck but could not be confirmed, so no fee or total is reported";

describe("get_checkout_quote", () => {
  test("is registered on the ChowBot server as a non-read-only tool", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const tool = tools.find((t: { name: string }) => t.name === "get_checkout_quote");

    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["restaurant_id", "address_id"]);
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.idempotentHint).toBe(false);
  });

  test("returns the quote breakdown, a labelled computed total and payment-method types", async () => {
    scriptCheckout();

    const result = await quote();

    expect(result.isError).toBeUndefined();
    expect(requestKeys()).toEqual([
      "GET /customer/cart/vendor/102555",
      "GET /customer/address",
      "GET /customer/vendor/102555",
      "POST /customer/delivery/amount",
      "GET /customer/payment/methods",
    ]);
    expect(received.every((r) => r.authorization === "Bearer secret-token-alice")).toBe(true);

    const parsed = JSON.parse(textOf(result));
    expect(parsed.restaurant).toEqual({
      id: 102555,
      name: "Chicken Republic - Opebi",
      minimum_order_amount: 250000,
      is_open: true,
      current_is_open_state: true,
      operationally_open: 1,
      is_closed_by_operations: false,
      is_temporarily_unavailable: false,
    });
    expect(parsed.cart).toMatchObject({ id: 30742921, total_price: 440000, is_valid: true });
    expect(parsed.cart.packs.map((p: { pack_reference: string }) => p.pack_reference)).toEqual([PACK_1, PACK_2]);
    expect(parsed.quote).toEqual({
      currency: "NGN",
      amount: 70000,
      final_delivery_amount: 70000,
      service_amount: 44000,
      final_service_amount: 44000,
      small_order_amount: 0,
      small_order_reason: null,
      safety_fee: 0,
      additional_order_fees: quoteData().additional_order_fees,
    });
    expect(parsed.computed_total).toEqual({
      amount: 554000,
      formula: "cart.total_price + quote.final_delivery_amount + quote.final_service_amount",
      source: "computed by ChowBot from raw Chowdeck amounts; not a total returned by Chowdeck",
    });
    expect(parsed.payment_methods).toEqual([
      { type: "wallet", pretty_name: "Wallet", is_current_active: false },
      { type: "online_payment", pretty_name: "Pay online", is_current_active: true },
    ]);
  });

  test("sends the observed delivery-amount body built only from the user's own data", async () => {
    scriptCheckout();

    await quote({ cart_id: 1, source_id: 2, destination_id: 3 });

    const [post] = quotePosts();
    expect(quotePosts()).toHaveLength(1);
    expect(post!.contentType).toContain("application/json");
    expect([...post!.query.keys()]).toEqual([]);
    expect(post!.body).toEqual({
      destination_id: ADDRESS_ID,
      order_class: "delivery",
      source_id: VENDOR_ADDRESS_ID,
      vendor_id: 102555,
      currency: "NGN",
      country_code: "NG",
      cart_id: 30742921,
    });
  });

  test("looks up payment methods with the computed total", async () => {
    scriptCheckout();

    await quote();

    const lookup = received.find((r) => r.path === "/customer/payment/methods")!;
    expect(Object.fromEntries(lookup.query)).toEqual({
      currency: "NGN",
      order_class: "delivery",
      amount: "554000",
    });
  });

  test("never returns fee IDs, source/destination IDs, wallet or address data", async () => {
    scriptCheckout();

    const text = textOf(await quote());

    for (const secret of [
      String(FEE_ID),
      String(VENDOR_ADDRESS_ID),
      String(ADDRESS_ID),
      "redacted-",
      "secret-token-alice",
      "distance",
      "savings",
      "170589",
      "balance",
      "123456",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test("never calls the discount, wallet or promo-code endpoints", async () => {
    scriptCheckout();

    await quote();

    const paths = received.map((r) => r.path);
    expect(paths.some((p) => p.includes("discount") || p.includes("wallet") || p.includes("promo"))).toBe(false);
  });

  test("keeps the quote when the payment-method lookup fails", async () => {
    scriptCheckout({ methods: () => Response.json({ message: "Server Error" }, { status: 500 }) });

    const result = await quote();
    const parsed = JSON.parse(textOf(result));

    expect(result.isError).toBeUndefined();
    expect(parsed.computed_total.amount).toBe(554000);
    expect(parsed.quote.final_delivery_amount).toBe(70000);
    expect(parsed.payment_methods).toBeNull();
    expect(parsed.payment_methods_error).toBe(
      "payment methods could not be retrieved (GET /customer/payment/methods failed with status 500: Server Error); the quote above is still valid",
    );
    expect(quotePosts()).toHaveLength(1);
  });

  test("keeps the quote when the payment-method reply is malformed", async () => {
    scriptCheckout({ methods: () => Response.json({ status: "success", data: [{ pretty_name: "Wallet" }] }) });

    const parsed = JSON.parse(textOf(await quote()));

    expect(parsed.payment_methods).toBeNull();
    expect(parsed.payment_methods_error).toContain("unexpected response shape");
  });

  test("does not compute a total when small_order_amount or safety_fee is non-zero", async () => {
    scriptCheckout({ quote: quoteResponse({ small_order_amount: 15000 }) });

    const parsed = JSON.parse(textOf(await quote()));

    expect(parsed.computed_total).toBeNull();
    expect(parsed.computed_total_unavailable_reason).toBe(
      "small_order_amount or safety_fee is non-zero, and how Chowdeck combines them is unknown",
    );
    expect(parsed.quote.small_order_amount).toBe(15000);
    expect(received.some((r) => r.path === "/customer/payment/methods")).toBe(false);
  });

  describe("refusals before any quote is requested", () => {
    test("refuses without a per-user session", async () => {
      const result = await callTool(serverFor(), "get_checkout_quote", {
        restaurant_id: 102555,
        address_id: ADDRESS_ID,
      });

      expect(textOf(result)).toContain("cannot identify individual users");
      expect(received).toHaveLength(0);
    });

    test("asks the user to sign in without contacting Chowdeck", async () => {
      scriptCheckout();

      const result = await quote({}, await sessionWith({ guestId: "guest-1" }));

      expect(textOf(result)).toBe(
        "Failed to get checkout quote: not signed in to Chowdeck. Sign in, then try again.",
      );
      expect(received).toHaveLength(0);
    });

    test("refuses an address that is not one of the user's saved addresses", async () => {
      scriptCheckout({ addresses: addressList([111, 222]) });

      const result = await quote();

      expect(textOf(result)).toBe(
        "Failed to get checkout quote: address_id is not one of your saved delivery addresses; call list_addresses to choose one",
      );
      expect(textOf(result)).not.toContain(String(ADDRESS_ID));
      expect(quotePosts()).toHaveLength(0);
    });

    test("refuses when there is no cart for the restaurant", async () => {
      scriptCheckout({ cart: noCart });

      const result = await quote();

      expect(textOf(result)).toBe("Failed to get checkout quote: there is no cart for this restaurant");
      expect(requestKeys()).toEqual(["GET /customer/cart/vendor/102555"]);
    });

    test.each([
      ["is_valid is false", { is_valid: false }],
      ["Chowdeck reports validation issues", {
        validation_result: [
          { pack_id: 1, pack_reference: PACK_1, issues: [{ type: "group", menu_id: 880557, group_id: 5844769, group_name: "Size", code: "REQUIRED_GROUP_MISSING", selection_count: 0, selections_required: 1 }] },
        ],
      }],
    ])("refuses an invalid cart when %s", async (_, overrides) => {
      scriptCheckout({ cart: cartResponse(overrides) });

      const result = await quote();

      expect(textOf(result)).toStartWith(
        "Failed to get checkout quote: the cart is not valid for checkout; validation issues: ",
      );
      expect(quotePosts()).toHaveLength(0);
    });

    test("returns sanitized validation details for an invalid cart", async () => {
      scriptCheckout({
        cart: cartResponse({
          is_valid: false,
          validation_result: [
            { pack_id: 1, pack_reference: PACK_1, issues: [{ code: "OUT_OF_STOCK", menu_id: 880557, action: ["REMOVE"], internal_note: "secret" }] },
          ],
        }),
      });

      const text = textOf(await quote());

      expect(text).toContain('"code":"OUT_OF_STOCK"');
      expect(text).toContain(PACK_1);
      expect(text).not.toContain("internal_note");
    });

    test.each([
      ["is_open is false", { is_open: false }],
      ["current_is_open_state is false", { current_is_open_state: false }],
      ["it is closed by operations", { is_closed_by_operations: true }],
      ["it is temporarily unavailable", { is_temporarily_unavailable: true }],
    ])("refuses when the restaurant %s", async (_, overrides) => {
      scriptCheckout({ vendor: vendorResponse(overrides) });

      const result = await quote();

      expect(textOf(result)).toBe("Failed to get checkout quote: this restaurant is currently closed");
      expect(quotePosts()).toHaveLength(0);
    });

    test("refuses a cart below the restaurant's minimum order without requesting a quote", async () => {
      scriptCheckout({ cart: cartResponse({ total_price: 220000 }) });

      const result = await quote();

      expect(textOf(result)).toBe(
        "Failed to get checkout quote: the cart total_price (220000) is below this restaurant's minimum_order_amount (250000); both are raw Chowdeck amounts",
      );
      expect(quotePosts()).toHaveLength(0);
    });

    test("refuses a malformed vendor response without requesting a quote", async () => {
      scriptCheckout({ vendor: vendorResponse({ address_id: null }) });

      const result = await quote();

      expect(textOf(result)).toBe(
        "Failed to get checkout quote: GET /customer/vendor/102555 returned an unexpected response shape",
      );
      expect(quotePosts()).toHaveLength(0);
    });

    test("keeps each user on their own token and address list", async () => {
      scriptCheckout({ addresses: addressList([111]) });

      const result = await quote({}, await sessionWith({ token: "secret-token-bob" }));

      expect(textOf(result)).toContain("not one of your saved delivery addresses");
      expect(received.map((r) => r.authorization)).toEqual([
        "Bearer secret-token-bob",
        "Bearer secret-token-bob",
      ]);
      expect(quotePosts()).toHaveLength(0);
    });

    test.each([
      [{ address_id: undefined }, "address_id"],
      [{ address_id: 0 }, "address_id"],
      [{ restaurant_id: "102555" }, "restaurant_id"],
    ])("rejects invalid input %p before contacting Chowdeck", async (args, field) => {
      const result = await quote(args);

      expect(textOf(result)).toContain("Input validation error");
      expect(textOf(result)).toContain(field);
      expect(received).toHaveLength(0);
    });
  });

  describe("quote failures", () => {
    const expectNoRetryNoTotal = (text: string) => {
      expect(quotePosts()).toHaveLength(1);
      expect(received.some((r) => r.path === "/customer/payment/methods")).toBe(false);
      expect(text).not.toContain("computed_total");
    };

    test("reports Chowdeck's minimum-order rejection verbatim", async () => {
      scriptCheckout({
        quote: () =>
          Response.json(
            {
              status: "failed",
              message:
                "The minimum order amount for this vendor is NGN 2,500.00. Please add more items to your cart to reach this amount.",
            },
            { status: 400 },
          ),
      });

      const text = textOf(await quote());

      expect(text).toBe(
        "Failed to get checkout quote: POST /customer/delivery/amount failed with status 400: The minimum order amount for this vendor is NGN 2,500.00. Please add more items to your cart to reach this amount.",
      );
      expect(text).not.toContain("may have been created");
      expectNoRetryNoTotal(text);
    });

    test("treats a server error as an uncertain outcome", async () => {
      scriptCheckout({ quote: () => Response.json({ message: "Server Error" }, { status: 502 }) });

      const text = textOf(await quote());

      expect(text).toBe(
        `Failed to get checkout quote: POST /customer/delivery/amount failed with status 502: Server Error; ${UNCERTAIN}`,
      );
      expectNoRetryNoTotal(text);
    });

    test("treats a timeout as an uncertain outcome", async () => {
      scriptCheckout({
        quote: async () => {
          await Bun.sleep(300);
          return quoteResponse()();
        },
      });

      const text = textOf(await quote({}, undefined, 100));

      expect(text).toBe(
        `Failed to get checkout quote: POST /customer/delivery/amount timed out after 100ms; ${UNCERTAIN}`,
      );
      expectNoRetryNoTotal(text);
    });

    test("treats a dropped connection as an uncertain outcome", async () => {
      scriptCheckout();
      const dropping: Server<undefined> = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method !== "POST") {
            return fetch(new URL(url.pathname + url.search, upstream.url), { headers: req.headers });
          }
          await record(req);
          dropping.stop(true);
          return new Promise<Response>(() => {});
        },
      });

      const result = await callTool(
        serverFor(await signedIn(), 1000, dropping.url.origin),
        "get_checkout_quote",
        { restaurant_id: 102555, address_id: ADDRESS_ID },
      );

      expect(textOf(result)).toBe(
        `Failed to get checkout quote: POST /customer/delivery/amount failed: network error; ${UNCERTAIN}`,
      );
      expectNoRetryNoTotal(textOf(result));
    });

    test.each([
      ["a non-success status", () => Response.json({ status: "pending", data: quoteData() })],
      ["no data", () => Response.json({ status: "success", message: "Amount computed successfully" })],
      ["no final delivery amount", () => Response.json({ status: "success", data: quoteData({ final_delivery_amount: undefined }) })],
      ["a non-numeric service amount", () => Response.json({ status: "success", data: quoteData({ final_service_amount: "44000" }) })],
    ])("does not report a quote when the reply has %s", async (_, reply) => {
      scriptCheckout({ quote: reply });

      const text = textOf(await quote());

      expect(text).toBe(
        `Failed to get checkout quote: POST /customer/delivery/amount returned an unexpected response; ${UNCERTAIN}`,
      );
      expect(text).not.toContain(String(FEE_ID));
      expectNoRetryNoTotal(text);
    });

    test("treats a non-JSON success body as an uncertain outcome", async () => {
      scriptCheckout({ quote: () => new Response("<html>ok</html>", { status: 200 }) });

      const text = textOf(await quote());

      expect(text).toBe(
        `Failed to get checkout quote: POST /customer/delivery/amount returned a non-JSON response; ${UNCERTAIN}`,
      );
      expectNoRetryNoTotal(text);
    });
  });
});

describe("preview_order (dry run)", () => {
  const preview = async (
    args: Record<string, unknown> = {},
    session?: UserSession,
    timeoutMs?: number,
  ) =>
    callTool(serverFor(session ?? (await signedIn()), timeoutMs), "preview_order", {
      restaurant_id: 102555,
      address_id: ADDRESS_ID,
      payment_method: "wallet",
      ...args,
    });

  /*
   * bag_quantity and the notes are cart fields the payload copies; the
   * cart capture showed bag_quantity 0, and the note values are invented.
   */
  const previewCart = (overrides: Record<string, unknown> = {}) =>
    cartResponse({ bag_quantity: 0, customer_vendor_note: null, ...overrides });

  const expectOnlyReads = () => {
    expect(received.every((r) => r.method === "GET")).toBe(true);
    expect(
      received.some((r) => /delivery\/amount|\/customer\/order|payment|discount|wallet|promo/.test(r.path)),
    ).toBe(false);
  };

  test("is registered as a read-only tool with only the supported payment choices", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const tool = tools.find((t: { name: string }) => t.name === "preview_order");

    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.inputSchema.required).toEqual(["restaurant_id", "address_id", "payment_method"]);
    expect(tool.inputSchema.properties.payment_method.enum).toEqual(["wallet", "pay_for_me"]);
  });

  test("builds the wallet delivery payload using only GET requests", async () => {
    scriptCheckout({ cart: previewCart() });

    const result = await preview();
    const parsed = JSON.parse(textOf(result));

    expect(result.isError).toBeUndefined();
    expect(requestKeys()).toEqual([
      "GET /customer/cart/vendor/102555",
      "GET /customer/address",
      "GET /customer/vendor/102555",
    ]);
    expectOnlyReads();
    expect(received.every((r) => r.authorization === "Bearer secret-token-alice")).toBe(true);

    expect(parsed.dry_run).toBe(true);
    expect(parsed.submitted).toBe(false);
    expect(parsed.cart).toEqual({ id: 30742921, total_price: 440000, currency: "NGN", pack_count: 2 });
    expect(parsed.payload_preview).toEqual({
      source: "web",
      vendor_id: 102555,
      cart_id: 30742921,
      checkout_from_cart: true,
      class: "delivery",
      payment_method: "wallet",
      promo_codes: [],
      customer_vendor_note: null,
      customer_delivery_note: "<withheld: copied from your cart>",
      bag_quantity: 0,
      requires_delivery_pin: true,
      fee_id: "<withheld: a submission would first request a fresh delivery-fee quote, which creates a fee record, so a dry run requests none>",
      address_id: "<withheld: your selected saved address>",
      split_payment_with_wallet: false,
      gift_recipient: null,
      country_code: "NG",
      currency: "NGN",
    });
    expect(parsed.omitted_fields).toEqual({
      payment_method_id: "not sent for wallet: the payment methods Chowdeck lists carry no id",
      tip: "no tip is added in a preview",
    });
    expect(parsed.not_performed).toContain("no order was created");
    expect(parsed.assumptions.length).toBeGreaterThan(0);
  });

  test("sends has_external_payment instead of payment_method_id for pay_for_me", async () => {
    scriptCheckout({ cart: previewCart() });

    const parsed = JSON.parse(textOf(await preview({ payment_method: "pay_for_me" })));

    expect(parsed.payload_preview.payment_method).toBe("pay_for_me");
    expect(parsed.payload_preview.has_external_payment).toBe(true);
    expect(parsed.payload_preview).not.toHaveProperty("payment_method_id");
    expect(parsed.omitted_fields.payment_method_id).toBe("replaced by has_external_payment for pay_for_me");
  });

  test("uses vendor_delivery for a restaurant that delivers itself", async () => {
    scriptCheckout({ cart: previewCart(), vendor: vendorResponse({ self_delivery: true }) });

    const parsed = JSON.parse(textOf(await preview()));

    expect(parsed.payload_preview.class).toBe("vendor_delivery");
  });

  test("leaves bag_quantity out when the cart has none", async () => {
    scriptCheckout({ cart: previewCart({ bag_quantity: undefined }) });

    const parsed = JSON.parse(textOf(await preview()));

    expect(parsed.payload_preview).not.toHaveProperty("bag_quantity");
    expect(parsed.omitted_fields.bag_quantity).toBe("the cart has no numeric bag_quantity");
  });

  test("withholds every private value", async () => {
    scriptCheckout({ cart: previewCart({ customer_vendor_note: "PRIVATE-vendor-note" }) });

    const text = textOf(await preview());

    for (const secret of [
      String(ADDRESS_ID),
      String(VENDOR_ADDRESS_ID),
      String(FEE_ID),
      "PRIVATE-",
      "redacted-",
      "redacted note",
      "secret-token-alice",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  test.each([["online_payment"], ["card"], [""], [undefined]])(
    "rejects the payment choice %p before contacting Chowdeck",
    async (paymentMethod) => {
      const result = await preview({ payment_method: paymentMethod });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Input validation error");
      expect(received).toHaveLength(0);
    },
  );

  test("refuses without a per-user session", async () => {
    const result = await callTool(serverFor(), "preview_order", {
      restaurant_id: 102555,
      address_id: ADDRESS_ID,
      payment_method: "wallet",
    });

    expect(textOf(result)).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });

  test("asks the user to sign in without contacting Chowdeck", async () => {
    scriptCheckout({ cart: previewCart() });

    const result = await preview({}, await sessionWith({ guestId: "guest-1" }));

    expect(textOf(result)).toBe("Failed to preview order: not signed in to Chowdeck. Sign in, then try again.");
    expect(received).toHaveLength(0);
  });

  test.each([
    ["there is no cart", { cart: noCart }, "there is no cart for this restaurant"],
    ["the cart is invalid", { cart: previewCart({ is_valid: false }) }, "the cart is not valid for checkout; validation issues: []"],
    ["the cart is empty", { cart: previewCart({ cart_items: [] }) }, "the cart has no items"],
    ["the cart belongs to another restaurant", { cart: previewCart({ vendor_id: 102556 }) }, "GET /customer/cart/vendor/102555 returned an unexpected response shape"],
    ["the address is not the user's", { cart: previewCart(), addresses: addressList([111]) }, "address_id is not one of your saved delivery addresses; call list_addresses to choose one"],
    ["the restaurant is closed", { cart: previewCart(), vendor: vendorResponse({ current_is_open_state: false }) }, "this restaurant is currently closed"],
    ["the cart is below the minimum", { cart: previewCart({ total_price: 220000 }) }, "the cart total_price (220000) is below this restaurant's minimum_order_amount (250000); both are raw Chowdeck amounts"],
    ["the restaurant uses another currency", { cart: previewCart(), vendor: vendorResponse({ currency: "GHS" }) }, "only NGN orders can be previewed; this restaurant uses a different currency"],
  ])("refuses when %s, using only reads", async (_, handlers, message) => {
    scriptCheckout(handlers);

    const result = await preview();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(`Failed to preview order: ${message}`);
    expectOnlyReads();
  });

  test("reports an upstream error without retrying", async () => {
    scriptCheckout({ cart: previewCart(), vendor: () => Response.json({ message: "Server Error" }, { status: 500 }) });

    const result = await preview();

    expect(textOf(result)).toBe(
      "Failed to preview order: GET /customer/vendor/102555 failed with status 500: Server Error",
    );
    expect(received.filter((r) => r.path === "/customer/vendor/102555")).toHaveLength(1);
    expectOnlyReads();
  });

  test("reports a timeout without retrying", async () => {
    scriptCheckout({
      cart: async () => {
        await Bun.sleep(300);
        return previewCart()();
      },
    });

    const result = await preview({}, undefined, 100);

    expect(textOf(result)).toBe(
      "Failed to preview order: GET /customer/cart/vendor/102555 timed out after 100ms",
    );
    expect(received).toHaveLength(1);
  });

  test("never creates an order, quote or payment, and never changes the cart", async () => {
    scriptCheckout({ cart: previewCart() });

    for (const payment_method of ["wallet", "pay_for_me"]) {
      await preview({ payment_method });
    }

    expect(received.map((r) => r.method)).not.toContain("POST");
    expect(received.map((r) => r.method)).not.toContain("DELETE");
    expect(quotePosts()).toHaveLength(0);
    expectOnlyReads();
  });
});

describe("get_checkout_quote orderable quotes", () => {
  /*
   * A test double for the per-user store: it records what would be saved,
   * or fails like an unavailable database.
   */
  const recordingStore = (failWith?: Error) => {
    const saved: NewQuote[] = [];
    const store = {
      createQuote: async (quote: NewQuote) => {
        if (failWith) throw failWith;
        saved.push(quote);
        return { id: "0f6c1d2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5", quoteExpiresAt: new Date("2026-10-21T10:05:00Z") };
      },
    } as unknown as UserOrderSubmissions;
    return { store, saved };
  };

  const quoteWith = async (store?: UserOrderSubmissions) =>
    callTool(serverFor(await signedIn(), 1000, undefined, store), "get_checkout_quote", {
      restaurant_id: 102555,
      address_id: ADDRESS_ID,
    });

  const orderableCart = (overrides: Record<string, unknown> = {}) => cartResponse({ bag_quantity: 0, ...overrides });

  test("issues a quote_ref only after saving every submission input", async () => {
    scriptCheckout({ cart: orderableCart() });
    const { store, saved } = recordingStore();

    const parsed = JSON.parse(textOf(await quoteWith(store)));

    expect(parsed.orderable).toBe(true);
    expect(parsed.quote_ref).toBe("0f6c1d2e-3b4a-4c5d-8e9f-a0b1c2d3e4f5");
    expect(parsed.quote_valid_until).toBe("2026-10-21T10:05:00.000Z");
    expect(parsed.not_orderable_reasons).toBeUndefined();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({
      vendorId: 102555,
      cartId: 30742921,
      feeId: FEE_ID,
      addressId: ADDRESS_ID,
      cartFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      computedTotal: 554000,
    });
  });

  test("still never returns the fee id or address id with a quote_ref", async () => {
    scriptCheckout({ cart: orderableCart() });

    const text = textOf(await quoteWith(recordingStore().store));

    expect(text).not.toContain(String(FEE_ID));
    expect(text).not.toContain(String(ADDRESS_ID));
    expect(text).not.toContain(String(VENDOR_ADDRESS_ID));
  });

  test("stays informational without a durable store (stdio)", async () => {
    scriptCheckout({ cart: orderableCart() });

    const parsed = JSON.parse(textOf(await quoteWith()));

    expect(parsed.orderable).toBe(false);
    expect(parsed.quote_ref).toBeUndefined();
    expect(parsed.not_orderable_reasons).toEqual(["ordering is only available on the hosted ChowBot server"]);
    expect(parsed.computed_total.amount).toBe(554000);
  });

  test.each([
    ["no confident total", { quote: quoteResponse({ small_order_amount: 15000 }) }, "no total could be computed confidently"],
    ["no fee record", { quote: quoteResponse({ id: undefined }) }, "Chowdeck returned no usable delivery-fee record"],
    ["no bag_quantity on the cart", { cart: cartResponse() }, "the cart has no numeric bag_quantity"],
    ["a non-NGN restaurant", { vendor: vendorResponse({ currency: "GHS" }) }, "only NGN orders are supported"],
  ])("is not orderable with %s", async (_, handlers, reason) => {
    scriptCheckout({ cart: orderableCart(), ...handlers });
    const { store, saved } = recordingStore();

    const parsed = JSON.parse(textOf(await quoteWith(store)));

    expect(parsed.orderable).toBe(false);
    expect(parsed.quote_ref).toBeUndefined();
    expect(parsed.not_orderable_reasons).toContain(reason);
    expect(saved).toHaveLength(0);
  });

  test("degrades to informational when saving fails, without retrying the quote", async () => {
    scriptCheckout({ cart: orderableCart() });

    const result = await quoteWith(recordingStore(new Error("connection refused")).store);
    const parsed = JSON.parse(textOf(result));

    expect(result.isError).toBeUndefined();
    expect(parsed.orderable).toBe(false);
    expect(parsed.quote_ref).toBeUndefined();
    expect(parsed.not_orderable_reasons).toEqual(["the quote could not be saved for ordering"]);
    expect(parsed.quote.final_delivery_amount).toBe(70000);
    expect(quotePosts()).toHaveLength(1);
    expect(textOf(result)).not.toContain("connection refused");
  });

  test("never saves anything when the quote itself is rejected", async () => {
    scriptCheckout({
      cart: orderableCart(),
      quote: () => Response.json({ status: "failed", message: "Minimum order not met" }, { status: 400 }),
    });
    const { store, saved } = recordingStore();

    const result = await quoteWith(store);

    expect(result.isError).toBe(true);
    expect(saved).toHaveLength(0);
  });
});
