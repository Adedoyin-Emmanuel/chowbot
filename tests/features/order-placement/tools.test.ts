import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { callTool, rpc } from "../../helpers/mcp";
import { ChowdeckClient } from "../../../lib/client";
import type { UserSession } from "../../../lib/session";
import { createPaymentStartConfig } from "../../../features/payments/service";
import { registerOrderPlacementTools } from "../../../features/order-placement/tools";
import { CAPTURED_PAYMENT_CHANNEL_QUERY } from "../../../features/order-placement/channels";
import {
  ADDRESS_ID,
  CARD_CHANNEL_ID,
  CART_ID,
  FEE_ID,
  ORDER_ID,
  PAYMENT_LINK,
  QUOTED_TOTAL,
  VENDOR_ID,
  activeOrders,
  mock,
  orderCreated,
  orderRecord,
  parse,
  route,
  scriptOrder,
  sent,
  signedIn,
  slow,
  useMockChowdeck,
} from "../../helpers/ordering";

useMockChowdeck();

const serverFor = (session: UserSession, options: { timeoutMs?: number; enabled?: boolean } = {}) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerOrderPlacementTools(server, {
    session,
    client: new ChowdeckClient({ baseUrl: mock.url, timeoutMs: options.timeoutMs ?? 1000 }),
    paymentChannelQuery: CAPTURED_PAYMENT_CHANNEL_QUERY,
    paymentStartConfig: createPaymentStartConfig(),
    placeOrderEnabled: options.enabled ?? true,
  });
  return server;
};

const ORDER_ARGS = { restaurant_id: VENDOR_ID, address_id: ADDRESS_ID, quoted_total: QUOTED_TOTAL, payment_channel: "card" };

const place = async (args: Record<string, unknown> = {}, options: { timeoutMs?: number } = {}) =>
  callTool(serverFor(await signedIn(), options), "place_order", { ...ORDER_ARGS, ...args });

const orderPosts = () => sent("POST", "/customer/order");
const paymentStarts = () => sent("POST", "/customer/payment/start/v2");

describe("place_order registration", () => {
  test("is registered only when live ordering is enabled", async () => {
    const session = await signedIn();
    const names = (enabled: boolean) =>
      Object.keys((serverFor(session, { enabled })() as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);

    expect(names(true)).toEqual(["place_order"]);
    expect(names(false)).toEqual([]);
  });

  test("asks for no confirmation value or quote reference", async () => {
    const { tools } = await rpc(serverFor(await signedIn()), "tools/list", {});
    const properties = Object.keys(tools[0].inputSchema.properties);

    expect(properties).not.toContain("confirmation");
    expect(properties).not.toContain("quote_ref");
    expect(properties).not.toContain("acknowledge_unresolved_attempts");
    expect(tools[0].inputSchema.required).toEqual(expect.arrayContaining(["restaurant_id", "address_id", "quoted_total", "payment_channel"]));
  });
});

describe("place_order", () => {
  test("places the order in one call, sends it once, and returns the payment link", async () => {
    scriptOrder();

    const result = await place();
    const report = parse(result);

    expect(result.isError).toBeUndefined();
    expect(orderPosts()).toHaveLength(1);
    expect(orderPosts()[0]!.body).toMatchObject({
      source: "web",
      vendor_id: VENDOR_ID,
      cart_id: CART_ID,
      checkout_from_cart: true,
      class: "delivery",
      fee_id: FEE_ID,
      address_id: ADDRESS_ID,
      payment_method_id: CARD_CHANNEL_ID,
      bag_quantity: 0,
      promo_codes: [],
      customer_vendor_note: "No pepper",
      customer_delivery_note: null,
      gift_recipient: null,
    });
    expect(orderPosts()[0]!.body).not.toHaveProperty("tip");
    expect(sent("POST", "/customer/delivery/amount")).toHaveLength(1);
    expect(paymentStarts()).toHaveLength(1);
    expect(paymentStarts()[0]!.body).toMatchObject({ method: "card", order_id: ORDER_ID });
    expect(report).toMatchObject({
      action: "place_order",
      outcome: "order_created",
      order_id: ORDER_ID,
      payment_link: PAYMENT_LINK,
      status: { order_state: "awaiting_payment", chowdeck_order_status: "abandoned" },
      outcome_uncertain: false,
      safe_to_retry: false,
    });
    expect(report.message).toContain(PAYMENT_LINK);
    expect(report).not.toHaveProperty("confirmation");
  });

  test("never returns private values", async () => {
    scriptOrder();

    const text = (await place()).content[0]!.text;

    for (const marker of ["PRIVATE-reference", "PRIVATE-pin", "4821", String(FEE_ID), String(ADDRESS_ID), "secret-token"]) {
      expect(text).not.toContain(marker);
    }
  });

  test("reads the order and payment state from Chowdeck's order record, not the create response", async () => {
    scriptOrder();
    route("POST /customer/order", orderCreated({ made_payment: true }));

    const report = parse(await place());

    expect(report.status).toMatchObject({ order_state: "awaiting_payment", source: expect.stringMatching(/^Chowdeck's order record/) });
    expect(report.amount).toMatchObject({ total: "₦5,540.00", source: "Chowdeck's order record (total_price)" });
  });

  test("sends nothing when the total has changed since the quote", async () => {
    scriptOrder();
    route("POST /customer/delivery/amount", () =>
      Response.json({ status: "success", data: { id: FEE_ID, final_delivery_amount: 90000, final_service_amount: 44000, small_order_amount: 0, safety_fee: 0 } }),
    );

    const result = await place();
    const report = parse(result);

    expect(result.isError).toBe(true);
    expect(report.outcome).toBe("not_sent");
    expect(report.message).toContain("the total is now ₦5,740.00, not the ₦5,540.00 quoted");
    expect(report.next_step).toContain("quoted_total: 574000");
    expect(orderPosts()).toHaveLength(0);
  });

  test("sends nothing for a pocket order without a Pocket tag", async () => {
    scriptOrder();

    const result = await place({ payment_channel: "pocket" });

    expect(parse(result).outcome).toBe("not_sent");
    expect(mock.received).toHaveLength(0);
  });

  test("reports Chowdeck's definite rejection without retrying", async () => {
    scriptOrder();
    route("POST /customer/order", () => Response.json({ status: "failed", message: "Restaurant is closed" }, { status: 422 }));

    const report = parse(await place());

    expect(report).toMatchObject({ outcome: "rejected_by_chowdeck", outcome_uncertain: false, safe_to_retry: true });
    expect(report.message).toContain("Restaurant is closed");
    expect(orderPosts()).toHaveLength(1);
    expect(paymentStarts()).toHaveLength(0);
  });

  test("does not start payment when Chowdeck's order total differs from the estimate", async () => {
    scriptOrder();
    route(`GET /customer/order/${ORDER_ID}`, orderRecord({ total_price: 600000 }));

    const report = parse(await place());

    expect(report.outcome).toBe("order_created");
    expect(report).not.toHaveProperty("payment_link");
    expect(report.warnings.join(" ")).toContain("differs from ChowBot's estimate");
    expect(report.next_step).toContain(`start_payment with order_id ${ORDER_ID}`);
    expect(paymentStarts()).toHaveLength(0);
  });

  test("reports an unclear payment start inside the created order without repeating it", async () => {
    scriptOrder();
    route("POST /customer/payment/start/v2", () => Response.json({ message: "Server Error" }, { status: 502 }));

    const report = parse(await place());

    expect(report.outcome).toBe("order_created");
    expect(report.order_id).toBe(ORDER_ID);
    expect(report.payment).toMatchObject({ outcome: "unknown_outcome", outcome_uncertain: true, safe_to_retry: false });
    expect(report).not.toHaveProperty("payment_link");
    expect(paymentStarts()).toHaveLength(1);
    expect(orderPosts()).toHaveLength(1);
  });

  test("pay_for_me sends the pay-for-me choice and returns the share link, starting no payment", async () => {
    scriptOrder();
    route("POST /customer/order", orderCreated({ pay_for_me_url: "https://chowdeck.com/store/pay/AbC123" }));

    const report = parse(await place({ payment_channel: "pay_for_me" }));

    expect(orderPosts()[0]!.body).toMatchObject({ payment_method: "pay_for_me", has_external_payment: true });
    expect(orderPosts()[0]!.body).not.toHaveProperty("payment_method_id");
    expect(report.pay_for_me_link).toBe("https://chowdeck.com/store/pay/AbC123");
    expect(paymentStarts()).toHaveLength(0);
    expect(sent("GET", "/customer/payment/channel")).toHaveLength(0);
  });

  test("wallet checks the balance first and reports payment only from the order record", async () => {
    scriptOrder();
    route("GET /customer/wallet", () => Response.json({ status: "success", data: { total_balance: 900000, currency: "NGN" } }));
    route(`GET /customer/order/${ORDER_ID}`, orderRecord({ payment: { status: "success" }, status: "pending" }));

    const report = parse(await place({ payment_channel: "wallet" }));

    expect(orderPosts()[0]!.body).toMatchObject({ payment_method: "wallet" });
    expect(report.status.order_state).toBe("payment_confirmed");
    expect(paymentStarts()).toHaveLength(0);
  });

  test("wallet sends nothing when the balance is below the estimate", async () => {
    scriptOrder();
    route("GET /customer/wallet", () => Response.json({ status: "success", data: { total_balance: 1000, currency: "NGN" } }));

    const report = parse(await place({ payment_channel: "wallet" }));

    expect(report.outcome).toBe("not_sent");
    expect(orderPosts()).toHaveLength(0);
  });
});

/*
 * An unclear order response is never resent. Chowdeck's active orders, read
 * before and after sending, are the only evidence used.
 */
describe("place_order with an unclear outcome", () => {
  const newOrder = { id: ORDER_ID, vendor_id: VENDOR_ID, status: "abandoned", created_at: new Date().toISOString() };
  const earlierOrder = { id: 7000001, vendor_id: VENDOR_ID, status: "abandoned", created_at: "2026-10-01T10:00:00.000Z" };

  test("a timeout followed by exactly one new order at the restaurant is reported as that order", async () => {
    scriptOrder();
    route("GET /customer/order", activeOrders([earlierOrder]), activeOrders([earlierOrder, newOrder]));
    route("POST /customer/order", slow(orderCreated()));

    const report = parse(await place({}, { timeoutMs: 100 }));

    expect(orderPosts()).toHaveLength(1);
    expect(report).toMatchObject({ outcome: "order_created", order_id: ORDER_ID, outcome_uncertain: false });
    expect(report.chowdeck_confirmed[0]).toContain("now appears at this restaurant in your active Chowdeck orders");
    expect(sent("GET", "/customer/order").map((r) => r.query.get("status"))).toEqual(["active", "active"]);
  });

  test("a timeout with no new order is an unknown outcome, never retried", async () => {
    scriptOrder();
    route("GET /customer/order", activeOrders([earlierOrder]));
    route("POST /customer/order", slow(orderCreated()));

    const result = await place({}, { timeoutMs: 100 });
    const report = parse(result);

    expect(result.isError).toBe(true);
    expect(report).toMatchObject({ outcome: "unknown_outcome", outcome_uncertain: true, safe_to_retry: false });
    expect(report.message).toContain("does not prove none was created");
    expect(report.next_step).toContain("Do not place the order again");
    expect(orderPosts()).toHaveLength(1);
    expect(paymentStarts()).toHaveLength(0);
  });

  test("two new orders at the restaurant leave the outcome unknown and list both", async () => {
    scriptOrder();
    const other = { ...newOrder, id: ORDER_ID + 1 };
    route("GET /customer/order", activeOrders([]), activeOrders([newOrder, other]));
    route("POST /customer/order", () => Response.json({ message: "Server Error" }, { status: 500 }));

    const report = parse(await place());

    expect(report.outcome).toBe("unknown_outcome");
    expect(report.possible_orders.map((order: { id: number }) => order.id)).toEqual([ORDER_ID, ORDER_ID + 1]);
    expect(orderPosts()).toHaveLength(1);
  });

  test("a 401 is not taken as a rejection: the order may exist", async () => {
    scriptOrder();
    route("GET /customer/order", activeOrders([]));
    route("POST /customer/order", () => Response.json({ message: "Unauthenticated" }, { status: 401 }));

    const report = parse(await place());

    expect(report.outcome).toBe("unknown_outcome");
    expect(orderPosts()).toHaveLength(1);
  });

  test("a success without an order id is checked against Chowdeck, not trusted", async () => {
    scriptOrder();
    route("GET /customer/order", activeOrders([]), activeOrders([newOrder]));
    route("POST /customer/order", () => Response.json({ status: "success", data: {} }));

    const report = parse(await place());

    expect(report).toMatchObject({ outcome: "order_created", order_id: ORDER_ID });
    expect(orderPosts()).toHaveLength(1);
  });

  test("without the earlier list, a new order is matched by creation time", async () => {
    scriptOrder();
    route("GET /customer/order", () => Response.json({ message: "Server Error" }, { status: 500 }), activeOrders([earlierOrder, newOrder]));
    route("POST /customer/order", slow(orderCreated()));

    const report = parse(await place({}, { timeoutMs: 100 }));

    expect(report).toMatchObject({ outcome: "order_created", order_id: ORDER_ID });
  });

  test("when Chowdeck's orders cannot be read afterwards the outcome is unknown", async () => {
    scriptOrder();
    route("GET /customer/order", activeOrders([]), () => Response.json({ message: "Server Error" }, { status: 500 }));
    route("POST /customer/order", slow(orderCreated()));

    const report = parse(await place({}, { timeoutMs: 100 }));

    expect(report.outcome).toBe("unknown_outcome");
    expect(report.message).toContain("could not read your active Chowdeck orders");
    expect(orderPosts()).toHaveLength(1);
  });
});
