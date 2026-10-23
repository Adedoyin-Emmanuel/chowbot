import { inNaira } from "../../helpers/naira";
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
  ) =>
  () => {
    const server = new McpServer({ name: "ChowBot", version: "test" });
    registerCheckoutTools(
      server,
      session,
      new ChowdeckClient({ baseUrl: baseUrl ?? upstream.url.origin, timeoutMs }),
    );
    return server;
  };

const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;
const quotePosts = () =>
  received.filter((r) => r.method === "POST" && r.path === "/customer/delivery/amount");
const requestKeys = () => received.map((r) => `${r.method} ${r.path}`);

/*
 * A cart with two Fried Rice packs, its delivery fee and payment methods.
 * The address, vendor address and fee IDs are distinctive test values.
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
    expect(parsed.restaurant).toEqual(inNaira({
      id: 102555,
      name: "Chicken Republic - Opebi",
      minimum_order_amount: 250000,
      is_open: true,
      current_is_open_state: true,
      operationally_open: 1,
      is_closed_by_operations: false,
      is_temporarily_unavailable: false,
    }));
    expect(parsed.cart).toMatchObject({ id: 30742921, total_price: "₦4,400.00", is_valid: true });
    expect(parsed.cart.packs.map((p: { pack_reference: string }) => p.pack_reference)).toEqual([PACK_1, PACK_2]);
    expect(parsed.quote).toEqual(inNaira({
      currency: "NGN",
      amount: 70000,
      final_delivery_amount: 70000,
      service_amount: 44000,
      final_service_amount: 44000,
      small_order_amount: 0,
      small_order_reason: null,
      safety_fee: 0,
      additional_order_fees: quoteData().additional_order_fees,
    }));
    expect(parsed.computed_total).toEqual({
      amount: "₦5,540.00",
      formula: "cart.total_price + quote.final_delivery_amount + quote.final_service_amount",
      source: "computed by ChowBot from Chowdeck's cart total and fees; not a total returned by Chowdeck",
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
    expect(parsed.computed_total.amount).toBe("₦5,540.00");
    expect(parsed.quote.final_delivery_amount).toBe("₦700.00");
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
    expect(parsed.quote.small_order_amount).toBe("₦150.00");
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
        "Failed to get checkout quote: the cart total (₦2,200.00) is below this restaurant's minimum order (₦2,500.00)",
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

describe("get_checkout_quote orderable quotes", () => {
  const quote = async () =>
    callTool(serverFor(await signedIn()), "get_checkout_quote", { restaurant_id: 102555, address_id: ADDRESS_ID });

  const orderableCart = (overrides: Record<string, unknown> = {}) => cartResponse({ bag_quantity: 0, ...overrides });

  test("is orderable when every value an order needs is known, and stores nothing", async () => {
    scriptCheckout({ cart: orderableCart() });

    const parsed = JSON.parse(textOf(await quote()));

    expect(parsed.orderable).toBe(true);
    expect(parsed.not_orderable_reasons).toBeUndefined();
    expect(parsed.computed_total.amount).toBe("₦5,540.00");
    expect(parsed).not.toHaveProperty("quote_ref");
    expect(parsed).not.toHaveProperty("quote_valid_until");
  });

  test("never returns the fee id or address id", async () => {
    scriptCheckout({ cart: orderableCart() });

    const text = textOf(await quote());

    expect(text).not.toContain(String(FEE_ID));
    expect(text).not.toContain(String(ADDRESS_ID));
    expect(text).not.toContain(String(VENDOR_ADDRESS_ID));
  });

  test.each([
    ["no confident total", { quote: quoteResponse({ small_order_amount: 15000 }) }, "no total could be computed confidently"],
    ["no fee record", { quote: quoteResponse({ id: undefined }) }, "Chowdeck returned no usable delivery-fee record"],
    ["no bag_quantity on the cart", { cart: cartResponse() }, "the cart has no numeric bag_quantity"],
    ["a non-NGN restaurant", { vendor: vendorResponse({ currency: "GHS" }) }, "only NGN orders are supported"],
  ])("is not orderable with %s", async (_, handlers, reason) => {
    scriptCheckout({ cart: orderableCart(), ...handlers });

    const parsed = JSON.parse(textOf(await quote()));

    expect(parsed.orderable).toBe(false);
    expect(parsed.not_orderable_reasons).toContain(reason);
  });
});

/*
 * Promo codes applied in a quote: 5FOR5 (free delivery) and DECK11 (N500 off).
 * Values other than the codes are fictional.
 */
describe("promo codes in a quote", () => {
  const promoEntry = (overrides: Record<string, unknown> = {}) => ({
    id: 6799451, code: "5FOR5", note: "5FOR5 - Free delivery", user_id: 523668, promo_code_id: 206251, amount: 0, is_valid: 1,
    expiry_time: "2099-10-31T23:59:59.000Z", created_at: "2026-10-22T09:59:01.000Z", updated_at: "2026-10-22T09:59:01.000Z",
    discount_id: 580242, maximum_usage_count: 1, usage_count: 0, minimum_order_amount: 300000, claim_source: null, vendor_id: null,
    title: "5FOR5", target_service: "deliveryfees", type: "5for5_marketing_first_time_orders", settings: "{\"has_multiple_discounts\":false}",
    maximum_order_amount: 0, voucher_type: "discount", display_name: null, voucher_status: null, vendor_ids: [], voucher_worth: 0, vendors: [],
    ...overrides,
  });
  const promoList = (entries: Record<string, unknown>[] = [promoEntry(), promoEntry({ id: 880538, code: "DECK11", note: "Registration discount", title: "N500 off", target_service: "orders", minimum_order_amount: 250000 })]) => () =>
    Response.json({ status: "success", message: "Promo codes retrieved successfully", data: entries });
  const discountList = () => Response.json({ status: "success", message: "Discounts retrieved successfully", data: [] });
  const applied = (entries: Record<string, unknown>[] = [{
    discount_id: 580242, title: "5FOR5", description: "Free delivery", amount_off: 70000, target: "deliveryfees", menu_price: 0, menu_total_price: 0,
    source: 0, shared_percent: 100, capped_amount_per_user: null, capped_amount: null, max_usage_capped_amount: 100000, additional_items: [],
    bogof_amount_off: 0, vendor_id: 102555, discount_terms: "Capped at NGN 1000. Minimum order amount is NGN 3000.", maximum_usage_count: 1, usage_count: 0, promo_code: "5FOR5",
  }]) => () => Response.json({ status: "success", message: "Discounts applied successfully", data: entries });

  const script = (handlers: { promos?: Handler; discounts?: Handler; apply?: Handler } = {}) => {
    scriptCheckout({ cart: cartResponse({ bag_quantity: 0 }) });
    route("GET /customer/promo-code", handlers.promos ?? promoList());
    route("GET /customer/discount", handlers.discounts ?? discountList);
    route("POST /customer/discount/apply", handlers.apply ?? applied());
  };

  const quoteWithPromo = async (promo_code = "5FOR5") =>
    callTool(serverFor(await signedIn()), "get_checkout_quote", {
      restaurant_id: 102555,
      address_id: ADDRESS_ID,
      promo_code,
    });

  const applyCalls = () => received.filter((r) => r.path === "/customer/discount/apply");

  test("applies an account code with the fresh quote's fee and shows Chowdeck's discount", async () => {
    script();

    const result = await quoteWithPromo("5for5");
    const parsed = JSON.parse(textOf(result));

    expect(result.isError).toBeUndefined();
    expect(parsed.orderable).toBe(true);
    expect(parsed.promo).toMatchObject(inNaira({
      promo_code: "5FOR5",
      status: "applied",
      discount: "₦700.00",
      discount_raw: 70000,
      estimated_total_after_discount: { amount: 484000, display: "₦4,840.00" },
    }));
    expect(parsed.promo.chowdeck_discounts[0]).toMatchObject({ title: "5FOR5", description: "Free delivery", promo_code: "5FOR5", amount: "₦700.00" });
    expect(parsed.promo.estimated_total_after_discount.source).toContain("read from Chowdeck's order record before payment");
    expect(parsed.computed_total.amount).toBe("₦5,540.00");

    const [apply] = applyCalls();
    expect(apply!.body).toMatchObject({ promo_codes: ["5FOR5"], fee_id: FEE_ID, delivery_fee: 70000, cart_id: 30742921, order_class: "delivery" });
    expect(requestKeys()).toEqual([
      "GET /customer/cart/vendor/102555",
      "GET /customer/address",
      "GET /customer/vendor/102555",
      "GET /customer/promo-code",
      "GET /customer/discount",
      "POST /customer/delivery/amount",
      "GET /customer/payment/methods",
      "POST /customer/discount/apply",
    ]);
    expect(textOf(result)).not.toContain(String(FEE_ID));
    expect(textOf(result)).not.toContain(String(ADDRESS_ID));
    expect(textOf(result)).not.toContain("523668");
  });

  test.each([
    ["is not on the account", "NOTMINE", promoList(), "is not on your Chowdeck account"],
    ["is expired", "5FOR5", promoList([promoEntry({ expiry_time: "2020-01-01T00:00:00.000Z" })]), "it expired at 2020-01-01T00:00:00.000Z"],
    ["was used up", "5FOR5", promoList([promoEntry({ usage_count: 1 })]), "it has been used the maximum number of times"],
    ["is marked not valid", "5FOR5", promoList([promoEntry({ is_valid: 0 })]), "Chowdeck marks it not valid"],
    ["is limited to another restaurant", "5FOR5", promoList([promoEntry({ vendor_ids: [999] })]), "it is limited to other restaurants"],
  ])("refuses a code that %s before any fee quote", async (_, code, promos, message) => {
    script({ promos });

    const result = await quoteWithPromo(code);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(message);
    expect(quotePosts()).toHaveLength(0);
    expect(applyCalls()).toHaveLength(0);
  });

  test("refuses when the promo lists cannot be read, before any fee quote", async () => {
    script({ promos: () => Response.json({ message: "Server Error" }, { status: 500 }), discounts: () => Response.json({ message: "Server Error" }, { status: 500 }) });

    const result = await quoteWithPromo();

    expect(textOf(result)).toContain("ChowBot could not check the promo code 5FOR5 against your account");
    expect(quotePosts()).toHaveLength(0);
  });

  test.each([
    ["returns no discount for the code", applied([]), "not_applied"],
    ["returns only another code's discount", applied([{ amount_off: 5000, target: "menus", promo_code: "DECK11" }]), "not_applied"],
    ["refuses the code", () => Response.json({ status: "failed", message: "Promo code has expired" }, { status: 422 }), "rejected"],
    ["fails upstream", () => Response.json({ message: "Server Error" }, { status: 503 }), "unconfirmed"],
    ["answers a failed envelope", () => Response.json({ status: "failed", message: "Promo code does not exist" }), "unconfirmed"],
  ])("is not orderable when Chowdeck's calculation %s, and never retries it", async (_, apply, status) => {
    script({ apply });

    const result = await quoteWithPromo();
    const parsed = JSON.parse(textOf(result));

    expect(parsed.orderable).toBe(false);
    expect(parsed.promo.status).toBe(status);
    expect(parsed.promo).not.toHaveProperty("estimated_total_after_discount");
    expect(parsed.not_orderable_reasons.join("\n")).toContain("leave promo_code out to order without it");
    expect(applyCalls()).toHaveLength(1);
    expect(quotePosts()).toHaveLength(1);
  });

  test("a quote without promo_code reads no promo lists and runs no discount calculation", async () => {
    script();

    const parsed = JSON.parse(textOf(await callTool(serverFor(await signedIn()), "get_checkout_quote", { restaurant_id: 102555, address_id: ADDRESS_ID })));

    expect(received.some((r) => /promo-code|discount/.test(r.path))).toBe(false);
    expect(parsed).not.toHaveProperty("promo");
  });
});

describe("list_promo_codes", () => {
  const list = async (args: Record<string, unknown> = {}) =>
    callTool(serverFor(await signedIn()), "list_promo_codes", args);

  const entries = [
    { id: 1, user_id: 523668, promo_code_id: 9, discount_id: 44, code: "DECK11", title: "N500 off", note: "Registration discount", is_valid: 1, expiry_time: "2030-12-31T23:59:59.000Z", usage_count: 0, maximum_usage_count: 1, minimum_order_amount: 250000, target_service: "orders", vendor_ids: [], settings: "{}" },
    { id: 2, user_id: 523668, code: "OLD", title: "Old", is_valid: 1, expiry_time: "2020-01-01T00:00:00.000Z", usage_count: 0, maximum_usage_count: 1, vendor_ids: [] },
    { id: 3, user_id: 523668, code: "ELSEWHERE", title: "Other shop", is_valid: 1, expiry_time: "2030-01-01T00:00:00.000Z", usage_count: 0, maximum_usage_count: 0, vendor_ids: [999] },
  ];

  test("lists the account's codes and discounts with ChowBot's reading, without private ids, read-only", async () => {
    route("GET /customer/promo-code", () => Response.json({ status: "success", data: entries }));
    route("GET /customer/discount", () => Response.json({ status: "success", data: [] }));

    const result = await list({ restaurant_id: 102555 });
    const parsed = JSON.parse(textOf(result));

    expect(result.isError).toBeUndefined();
    expect(parsed.promo_codes.map((p: { code: string }) => p.code)).toEqual(["DECK11", "OLD", "ELSEWHERE"]);
    expect(parsed.promo_codes[0]).toMatchObject({ title: "N500 off", minimum_order_amount: "₦2,500.00", chowbot_check: { looks_usable: true, problems: [] } });
    expect(parsed.promo_codes[1].chowbot_check.problems).toEqual(["it expired at 2020-01-01T00:00:00.000Z"]);
    expect(parsed.promo_codes[2].chowbot_check.problems).toEqual(["it is limited to other restaurants"]);
    expect(parsed.discounts).toEqual([]);
    expect(parsed.basis.join("\n")).toContain("not a promise of a discount");
    for (const field of ["user_id", "promo_code_id", "discount_id", "settings"]) expect(parsed.promo_codes[0]).not.toHaveProperty(field);
    expect(textOf(result)).not.toContain("523668");
    expect(received.every((r) => r.method === "GET")).toBe(true);
  });

  test("reports a list it could not read, and fails only when neither can be read", async () => {
    route("GET /customer/promo-code", () => Response.json({ status: "success", data: entries }));
    route("GET /customer/discount", () => Response.json({ message: "Server Error" }, { status: 500 }));
    const partial = JSON.parse(textOf(await list()));
    expect(partial.promo_codes).toHaveLength(3);
    expect(partial.errors.join("\n")).toContain("GET /customer/discount failed with status 500");

    route("GET /customer/promo-code", () => Response.json({ message: "Server Error" }, { status: 500 }));
    const failed = await list();
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain("neither promo list could be read");
  });
});
