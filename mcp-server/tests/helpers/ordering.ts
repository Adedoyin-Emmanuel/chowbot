import type { Server } from "bun";
import { afterAll, beforeAll, beforeEach } from "bun:test";

import { bindSession, InMemorySessionStore } from "../../lib/session";

/*
 * A mock Chowdeck for the ordering and payment tools. Each route answers with
 * its handlers in turn, repeating the last one. Values are fictional; private
 * fields carry a "PRIVATE-" marker so leaks are detectable.
 */

export type Received = { method: string; path: string; query: URLSearchParams; body: unknown };
export type Handler = () => Response | Promise<Response>;

export const ADDRESS_ID = 918273;
export const VENDOR_ID = 102555;
export const VENDOR_ADDRESS_ID = 645372;
export const FEE_ID = 99887766;
export const CART_ID = 30742921;
export const CARD_CHANNEL_ID = 11;
export const ORDER_ID = 7001326;
export const QUOTED_TOTAL = 554000; // 440000 cart + 70000 delivery + 44000 service
export const PAYMENT_LINK = "https://checkout.paystack.com/PRIVATE-PAYMENT-LINK";

export const mock = { url: "", received: [] as Received[], routes: new Map<string, Handler[]>() };
let upstream: Server<undefined>;

export const useMockChowdeck = () => {
  beforeAll(() => {
    upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const text = await req.text();
        mock.received.push({ method: req.method, path: url.pathname, query: url.searchParams, body: text ? JSON.parse(text) : undefined });
        const queue = mock.routes.get(`${req.method} ${url.pathname}`);
        if (!queue || queue.length === 0) return Response.json({ message: "unexpected request" }, { status: 500 });
        return (queue.length > 1 ? queue.shift()! : queue[0]!)();
      },
    });
    mock.url = upstream.url.origin;
  });
  afterAll(() => upstream.stop(true));
  beforeEach(() => {
    mock.received = [];
    mock.routes = new Map();
  });
};

export const route = (key: string, ...handlers: Handler[]) => mock.routes.set(key, handlers);
export const sent = (method: string, path: string) => mock.received.filter((r) => r.method === method && r.path === path);
export const slow = (handler: Handler, ms = 300): Handler => async () => (await Bun.sleep(ms), handler());

export const signedIn = async () => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save({ token: "secret-token-alice" });
  return session;
};

const packRows = (pack: string, ids: [number, number]) => [
  { id: ids[0], item_id: 880557, name: "Fried Rice", type: "menu", quantity: 1, price_per_quantity: 180000, menu_group_id: null, pack_reference: pack },
  { id: ids[1], item_id: 4366226, name: "Take-away pack", type: "group", quantity: 1, price_per_quantity: 40000, menu_group_id: 5844771, pack_reference: pack },
];

export const cart = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: {
      id: CART_ID, vendor_id: VENDOR_ID, status: "active", currency: "NGN", total_price: 440000, is_valid: true,
      validation_result: [], bag_quantity: 0, customer_vendor_note: "No pepper", customer_delivery_note: null,
      vendor: { id: VENDOR_ID, name: "Chicken Republic - Opebi" },
      cart_items: [...packRows("pack-a", [1, 2]), ...packRows("pack-b", [3, 4])],
      ...overrides,
    },
  });

export const quote = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: { id: FEE_ID, amount: 70000, final_delivery_amount: 70000, service_amount: 44000, final_service_amount: 44000, small_order_amount: 0, safety_fee: 0, currency: "NGN", ...overrides },
  });

export const orderCreated = (data: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    message: "Order successfully saved",
    data: { id: ORDER_ID, reference: "PRIVATE-reference", made_payment: false, pay_for_me_url: null, delivery_pin: 4821, ...data },
  });

/*
 * Chowdeck's record of a freshly created, unpaid order: status "abandoned",
 * payment {} (observed).
 */
export const orderRecord = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: {
      id: ORDER_ID, vendor_id: VENDOR_ID, status: "abandoned", payment: {}, time_payment_confirmed: null,
      total_price: QUOTED_TOTAL, items_price: 440000, delivery_price: 70000, service_price: 44000,
      customer_vendor_note: "No pepper", customer_delivery_note: null, order_pin: "PRIVATE-pin",
      created_at: new Date().toISOString(), ...overrides,
    },
  });

export const activeOrders = (orders: Record<string, unknown>[] = []) => () =>
  Response.json({ status: "success", data: orders });

export const paymentStarted = (data: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: { processor: "paystack", reference: "PRIVATE-reference", authorization_url: PAYMENT_LINK, ...data },
  });

/*
 * Everything a card order needs, from cart to payment link.
 */
export const scriptOrder = () => {
  route(`GET /customer/cart/vendor/${VENDOR_ID}`, cart());
  route("GET /customer/address", () => Response.json({ status: "success", data: [{ id: ADDRESS_ID, pretty_name: "Home" }] }));
  route(`GET /customer/vendor/${VENDOR_ID}`, () =>
    Response.json({
      status: "success",
      data: { id: VENDOR_ID, name: "Chicken Republic - Opebi", address_id: VENDOR_ADDRESS_ID, minimum_order_amount: 250000, is_open: true, self_delivery: false, currency: "NGN" },
    }),
  );
  route("POST /customer/delivery/amount", quote());
  route("GET /customer/payment/channel", () =>
    Response.json({ status: "success", data: [{ id: CARD_CHANNEL_ID, name: "card", processor: "paystack", is_active: 1 }, { id: 12, name: "pocket", processor: "pocket", is_active: 1 }] }),
  );
  route("GET /customer/order", activeOrders());
  route("POST /customer/order", orderCreated());
  route(`GET /customer/order/${ORDER_ID}`, orderRecord());
  route("POST /customer/payment/start/v2", paymentStarted());
};

export const parse = (result: { content: { text: string }[] }) => JSON.parse(result.content[0]!.text);
