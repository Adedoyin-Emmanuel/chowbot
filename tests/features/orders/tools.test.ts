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
import { registerOrderTools } from "../../../features/orders/tools";

type ReceivedRequest = {
  path: string;
  method: string;
  query: URLSearchParams;
  authorization: string | null;
};

type Handler = () => Response | Promise<Response>;

let upstream: Server<undefined>;
let received: ReceivedRequest[];
let routes: Map<string, Handler>;

const route = (key: string, handler: Handler) => routes.set(key, handler);

const record = (req: Request) => {
  const url = new URL(req.url);
  received.push({
    method: req.method,
    path: url.pathname,
    query: url.searchParams,
    authorization: req.headers.get("authorization"),
  });
  return url.pathname;
};

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      const handler = routes.get(`${req.method} ${record(req)}`);
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
  (session?: UserSession, timeoutMs = 1000, baseUrl?: string) =>
  () => {
    const server = new McpServer({ name: "ChowBot", version: "test" });
    registerOrderTools(
      server,
      session,
      new ChowdeckClient({
        baseUrl: baseUrl ?? upstream.url.origin,
        timeoutMs,
      }),
    );
    return server;
  };

const textOf = (result: { content: { text: string }[] }) =>
  result.content[0]!.text;

/*
 * Field names and shapes follow the sanitized order report (2026-10-20):
 * the order detail's money fields reconcile as observed, items follow the
 * cart report's past-order rows, and timeline level/action pairs are the
 * observed ones. Every ID and personal value here is an invented test value,
 * and each private field carries a "PRIVATE-" marker so leaks are detectable.
 */
const ORDER_ID = 7001001;
const ORDER_PATH = `/customer/order/${ORDER_ID}`;
const TIMELINE_PATH = `${ORDER_PATH}/timeline`;

const PRIVATE_FIELDS = {
  code: "PRIVATE-code",
  user_id: "PRIVATE-user",
  fee_id: "PRIVATE-fee-id",
  order_pin: "PRIVATE-pin",
  customer_note: "PRIVATE-note",
  reference: "PRIVATE-reference",
  customer_id: "PRIVATE-customer-id",
  customer_address_id: "PRIVATE-address-id",
  gift_recipient: { phone: "PRIVATE-gift-phone" },
  customer_delivery_note: "PRIVATE-delivery-note",
  vendorAddress: { street: "PRIVATE-vendor-street" },
  processor_reference: "PRIVATE-processor-reference",
  tracking_url: "https://track.example/PRIVATE-tracking",
  pay_for_me_url: "https://pay.example/PRIVATE-pay-for-me",
  customer: { name: "PRIVATE-name", phone: "PRIVATE-phone" },
  driver: { rider_name: "PRIVATE-rider", phone: "PRIVATE-rider-phone" },
  address: { street: "PRIVATE-street", coordinate: "PRIVATE-coordinate" },
};

const orderSummary = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  vendor_id: 4401,
  vendor_name: "Item 7 (Go) - Allen",
  order_items_count: 5,
  total_price: 1104000,
  service_price: 144000,
  currency: "NGN",
  status: "success",
  class: "delivery",
  created_at: "2026-10-01T12:00:00.000Z",
  ...PRIVATE_FIELDS,
  ...overrides,
});

const orderList = (orders: unknown[]) => () =>
  Response.json({
    status: "success",
    message: "Orders retrieved successfully",
    data: orders,
  });

const itemRow = (fields: Record<string, unknown>) => ({
  vendor_price_per_quantity: 1,
  menu_reference: "PRIVATE-menu-reference",
  menu_group_ids: "91878,91879",
  substitution_id: null,
  container_price: 0,
  is_discount_item: false,
  ...fields,
});

const orderDetail = (overrides: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  vendor_id: 4401,
  vendor_name: "Item 7 (Go) - Allen",
  status: "success",
  previous_status: "in_transit",
  class: "delivery",
  type: "single",
  source: "ios",
  domain: "live",
  currency: "NGN",
  total_price: 1104000,
  original_total_price: 1184000,
  items_price: 960000,
  original_items_price: 960000,
  vendor_items_price: 900000,
  delivery_price: 80000,
  service_price: 144000,
  small_order_price: 0,
  bag_fee: 0,
  safety_fee: 0,
  container_fee: 0,
  tip_amount: 0,
  tips_total: 0,
  discount_price: 80000,
  promo_code_price: 0,
  voucher_amount: 0,
  vendor_discount_amount: 0,
  charges_exempt_amount: 0,
  refund_amount: null,
  has_external_payment: false,
  time_payment_confirmed: "2026-10-01T12:00:05.000Z",
  estimated_delivery_time: "2026-10-01T12:40:00.000Z",
  actual_delivery_time: "2026-10-01T12:35:00.000Z",
  time_customer_received_order: "2026-10-01T12:36:00.000Z",
  is_failed_delivery: false,
  created_at: "2026-10-01T12:00:00.000Z",
  payment: {
    status: "success",
    amount: 1104000,
    method: "card",
    channel: "card",
    last4: "PRIVATE-last4",
    brand: "PRIVATE-brand",
    reference: "PRIVATE-payment-reference",
    authorization_code: "PRIVATE-authorization",
  },
  items: [
    itemRow({
      id: 161000039,
      type: "menu",
      item_id: 1110010,
      name: "A plate of rice with chicken",
      quantity: 1,
      pack_id: 1,
      price_per_quantity: 420000,
      total_price: 420000,
    }),
    itemRow({
      id: 161000040,
      type: "group",
      item_id: 366114,
      name: "Mixed Rice",
      quantity: 1,
      pack_id: 1,
      price_per_quantity: 0,
      total_price: 0,
      menugroup_id: 91878,
      menugroup_name: "Rice Option",
      menugroup_reference: "PRIVATE-group-reference",
    }),
    itemRow({
      id: 161000041,
      type: "group",
      item_id: 366118,
      name: "Extra plantain",
      quantity: 1,
      pack_id: 1,
      price_per_quantity: 50000,
      total_price: 50000,
      menugroup_id: 91879,
      menugroup_name: "Extras",
    }),
    itemRow({
      id: 161000043,
      type: "menu",
      item_id: 1110005,
      name: "Chicken shawarma",
      quantity: 1,
      pack_id: 2,
      price_per_quantity: 440000,
      total_price: 440000,
      discount_price_per_quantity: 360000,
      discount_total_price: 360000,
    }),
  ],
  timeline: [
    {
      action: "ORDER_CREATED",
      created_at: "2026-10-01T12:00:00.000Z",
      description: "Order placed",
      action_by: { id: "PRIVATE-actor" },
      source: "PRIVATE-source",
      json_description: { raw: "PRIVATE-json" },
    },
  ],
  ...PRIVATE_FIELDS,
  ...overrides,
});

const orderResponse =
  (overrides: Record<string, unknown> = {}) =>
  () =>
    Response.json({
      status: "success",
      message: "Order retrieved successfully",
      data: orderDetail(overrides),
    });

const OBSERVED_STEPS: [string, string][] = [
  ["received", "MADE_PAYMENT"],
  ["preparing", "VENDOR_ACCEPTED_ORDER"],
  ["awaiting_pickup", "AWAITING_PICKUP"],
  ["accepted_by_driver", "DRIVER_ACCEPTED_ORDER"],
  ["awaiting_pickup", "DRIVER_ARRIVED_AT_RESTAURANT"],
  ["in_transit", "DRIVER_PICKED_ORDER"],
  ["arrived", "DRIVER_ARRIVED_AT_CUSTOMER_LOCATION"],
  ["success", "ORDER_COMPLETED"],
];

const timelineEntries = () =>
  OBSERVED_STEPS.map(([level, action], index) => ({
    heading: `Step ${index + 1}`,
    description: `${action} description`,
    level,
    action,
    eta: null,
    time: `2026-10-01T12:0${index}:00.000Z`,
    json_description: { raw: "PRIVATE-json" },
    action_by: { id: "PRIVATE-actor", phone: "PRIVATE-actor-phone" },
    source: "PRIVATE-source",
  }));

const timelineResponse =
  (entries: unknown[] = timelineEntries()) =>
  () =>
    Response.json({
      message: "Successfully retrieved order timeline",
      data: entries,
    });

const expectNoPrivateData = (text: string) => {
  expect(text).not.toContain("PRIVATE-");
  expect(text).not.toContain("secret-token");
  for (const field of [
    "fee_id",
    "order_pin",
    "tracking_url",
    "pay_for_me_url",
    "last4",
    "brand",
    "action_by",
    "json_description",
    "customer",
    "driver",
  ]) {
    expect(text).not.toContain(`"${field}"`);
  }
};

const expectOnlyGets = () => {
  expect(received.every((r) => r.method === "GET")).toBe(true);
};

describe("order tools", () => {
  test("are registered as read-only tools", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const byName = (name: string) =>
      tools.find((t: { name: string }) => t.name === name);

    for (const name of ["list_orders", "get_order", "get_order_timeline"]) {
      expect(byName(name).annotations.readOnlyHint).toBe(true);
    }
    expect(byName("get_order").inputSchema.required).toEqual(["order_id"]);
    expect(byName("get_order_timeline").inputSchema.required).toEqual([
      "order_id",
    ]);
  });

  test.each([
    ["list_orders", {}],
    ["get_order", { order_id: ORDER_ID }],
    ["get_order_timeline", { order_id: ORDER_ID }],
  ])("%s refuses to run without a per-user session", async (tool, args) => {
    const result = await callTool(serverFor(), tool, args);

    expect(textOf(result)).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });

  test.each([
    ["list_orders", {}, "list orders"],
    ["get_order", { order_id: ORDER_ID }, "get order"],
    ["get_order_timeline", { order_id: ORDER_ID }, "get order timeline"],
  ])(
    "%s asks the user to sign in without contacting Chowdeck",
    async (tool, args, action) => {
      const result = await callTool(
        serverFor(await sessionWith({ guestId: "guest-1" })),
        tool,
        args,
      );

      expect(textOf(result)).toBe(
        `Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`,
      );
      expect(received).toHaveLength(0);
    },
  );

  test.each([
    [
      "list_orders",
      {},
      "GET /customer/order",
      () => route("GET /customer/order", orderList([])),
    ],
    [
      "get_order",
      { order_id: ORDER_ID },
      `GET ${ORDER_PATH}`,
      () => route(`GET ${ORDER_PATH}`, orderResponse()),
    ],
    [
      "get_order_timeline",
      { order_id: ORDER_ID },
      `GET ${TIMELINE_PATH}`,
      () => route(`GET ${TIMELINE_PATH}`, timelineResponse()),
    ],
  ])("%s uses each user's own token", async (tool, args, request, script) => {
    script();

    await callTool(
      serverFor(await sessionWith({ token: "secret-token-alice" })),
      tool,
      args,
    );
    await callTool(
      serverFor(await sessionWith({ token: "secret-token-bob" })),
      tool,
      args,
    );

    expect(
      received.map((r) => `${r.method} ${r.path} ${r.authorization}`),
    ).toEqual([
      `${request} Bearer secret-token-alice`,
      `${request} Bearer secret-token-bob`,
    ]);
  });
});

describe("list_orders", () => {
  const listOrders = async () =>
    callTool(serverFor(await signedIn()), "list_orders", {});

  test("lists completed orders as sanitized summaries", async () => {
    route(
      "GET /customer/order",
      orderList([
        orderSummary(ORDER_ID),
        orderSummary(7001002, {
          vendor_name: "Burger King - Ikeja GRA",
          total_price: 347020,
          service_price: 127020,
        }),
      ]),
    );

    const result = await listOrders();
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("GET");
    expect(received[0]!.path).toBe("/customer/order");
    expect(Object.fromEntries(received[0]!.query)).toEqual({
      status: "completed",
    });
    expect(JSON.parse(text)).toEqual({
      status_filter: "completed",
      returned: 2,
      orders: [
        {
          id: ORDER_ID,
          vendor_id: 4401,
          vendor_name: "Item 7 (Go) - Allen",
          status: "success",
          class: "delivery",
          currency: "NGN",
          total_price: 1104000,
          service_price: 144000,
          order_items_count: 5,
          created_at: "2026-10-01T12:00:00.000Z",
        },
        {
          id: 7001002,
          vendor_id: 4401,
          vendor_name: "Burger King - Ikeja GRA",
          status: "success",
          class: "delivery",
          currency: "NGN",
          total_price: 347020,
          service_price: 127020,
          order_items_count: 5,
          created_at: "2026-10-01T12:00:00.000Z",
        },
      ],
    });
    expectNoPrivateData(text);
  });

  test("returns an empty list when the user has no completed orders", async () => {
    route("GET /customer/order", orderList([]));

    const result = await listOrders();

    expect(JSON.parse(textOf(result))).toEqual({
      status_filter: "completed",
      returned: 0,
      orders: [],
    });
  });

  test.each([
    ["data is not a list", { data: {} }],
    ["data is missing", { status: "success" }],
    ["an order has no id", { data: [{ vendor_name: "No id" }] }],
    ["an order is not an object", { data: ["7001001"] }],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    route("GET /customer/order", () => Response.json(body));

    const result = await listOrders();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to list orders: GET /customer/order returned an unexpected response shape",
    );
  });

  test.each([
    [401, "Unauthenticated"],
    [500, "Server Error"],
  ])("reports an upstream %i as a tool error", async (status, message) => {
    route("GET /customer/order", () =>
      Response.json({ status: "failed", message }, { status }),
    );

    const result = await listOrders();

    expect(textOf(result)).toBe(
      `Failed to list orders: GET /customer/order failed with status ${status}: ${message}`,
    );
    expect(received).toHaveLength(1);
  });

  test("reports a timeout without retrying", async () => {
    route("GET /customer/order", async () => {
      await Bun.sleep(300);
      return orderList([])();
    });

    const result = await callTool(
      serverFor(await signedIn(), 100),
      "list_orders",
      {},
    );

    expect(textOf(result)).toBe(
      "Failed to list orders: GET /customer/order timed out after 100ms",
    );
    expect(received).toHaveLength(1);
  });
});

describe("get_order", () => {
  const getOrder = async (orderId: unknown = ORDER_ID) =>
    callTool(serverFor(await signedIn()), "get_order", { order_id: orderId });

  test("returns allowlisted order fields, payment state and items", async () => {
    route(`GET ${ORDER_PATH}`, orderResponse());

    const result = await getOrder();
    const text = textOf(result);

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${ORDER_PATH}`,
    ]);
    expect(JSON.parse(text)).toEqual({
      order: {
        id: ORDER_ID,
        vendor_id: 4401,
        vendor_name: "Item 7 (Go) - Allen",
        status: "success",
        previous_status: "in_transit",
        class: "delivery",
        type: "single",
        currency: "NGN",
        total_price: 1104000,
        original_total_price: 1184000,
        items_price: 960000,
        original_items_price: 960000,
        delivery_price: 80000,
        service_price: 144000,
        small_order_price: 0,
        bag_fee: 0,
        safety_fee: 0,
        container_fee: 0,
        tip_amount: 0,
        tips_total: 0,
        discount_price: 80000,
        promo_code_price: 0,
        voucher_amount: 0,
        vendor_discount_amount: 0,
        refund_amount: null,
        has_external_payment: false,
        time_payment_confirmed: "2026-10-01T12:00:05.000Z",
        estimated_delivery_time: "2026-10-01T12:40:00.000Z",
        actual_delivery_time: "2026-10-01T12:35:00.000Z",
        time_customer_received_order: "2026-10-01T12:36:00.000Z",
        is_failed_delivery: false,
        created_at: "2026-10-01T12:00:00.000Z",
        payment: {
          status: "success",
          amount: 1104000,
          method: "card",
          channel: "card",
        },
        items: [
          {
            type: "menu",
            item_id: 1110010,
            name: "A plate of rice with chicken",
            quantity: 1,
            pack_id: 1,
            price_per_quantity: 420000,
            total_price: 420000,
          },
          {
            type: "group",
            item_id: 366114,
            name: "Mixed Rice",
            quantity: 1,
            pack_id: 1,
            price_per_quantity: 0,
            total_price: 0,
            menugroup_id: 91878,
            menugroup_name: "Rice Option",
          },
          {
            type: "group",
            item_id: 366118,
            name: "Extra plantain",
            quantity: 1,
            pack_id: 1,
            price_per_quantity: 50000,
            total_price: 50000,
            menugroup_id: 91879,
            menugroup_name: "Extras",
          },
          {
            type: "menu",
            item_id: 1110005,
            name: "Chicken shawarma",
            quantity: 1,
            pack_id: 2,
            price_per_quantity: 440000,
            total_price: 440000,
            discount_price_per_quantity: 360000,
            discount_total_price: 360000,
          },
        ],
      },
    });
    expectNoPrivateData(text);
    expect(text).not.toContain("vendor_price_per_quantity");
    expect(text).not.toContain("ORDER_CREATED");
  });

  test("accepts the order id as a number or a string", async () => {
    route(`GET ${ORDER_PATH}`, orderResponse());

    const asNumber = await getOrder(ORDER_ID);
    const asString = await getOrder(String(ORDER_ID));

    expect(asNumber.isError).toBeUndefined();
    expect(asString.isError).toBeUndefined();
    expect(received.map((r) => r.path)).toEqual([ORDER_PATH, ORDER_PATH]);
  });

  test("uses the vendor object's name when there is no vendor_name", async () => {
    route(
      `GET ${ORDER_PATH}`,
      orderResponse({
        vendor_name: undefined,
        vendor: {
          id: 4401,
          name: "Item 7 (Go) - Allen",
          phone: "PRIVATE-vendor-phone",
        },
      }),
    );

    const text = textOf(await getOrder());

    expect(JSON.parse(text).order.vendor_name).toBe("Item 7 (Go) - Allen");
    expectNoPrivateData(text);
  });

  test("passes through payment and order statuses as Chowdeck reports them", async () => {
    route(
      `GET ${ORDER_PATH}`,
      orderResponse({
        status: "some_new_status",
        payment: { status: "pending", amount: 1104000 },
      }),
    );

    const parsed = JSON.parse(textOf(await getOrder()));

    expect(parsed.order.status).toBe("some_new_status");
    expect(parsed.order.payment).toEqual({
      status: "pending",
      amount: 1104000,
    });
  });

  test("reports a missing order with Chowdeck's message", async () => {
    route(`GET ${ORDER_PATH}`, () =>
      Response.json(
        { status: "failed", message: "Order not found" },
        { status: 404 },
      ),
    );

    const result = await getOrder();

    expect(textOf(result)).toBe(
      `Failed to get order: GET ${ORDER_PATH} failed with status 404: Order not found`,
    );
  });

  test.each([
    ["data is missing", { status: "success" }],
    ["data is a list", { status: "success", data: [] }],
    [
      "the order id does not match",
      { status: "success", data: orderDetail({ id: 7009999 }) },
    ],
    [
      "the order has no id",
      { status: "success", data: orderDetail({ id: undefined }) },
    ],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    route(`GET ${ORDER_PATH}`, () => Response.json(body));

    const result = await getOrder();

    expect(textOf(result)).toBe(
      `Failed to get order: GET ${ORDER_PATH} returned an unexpected response shape`,
    );
  });

  test("reports a dropped connection as a network error without retrying", async () => {
    const dropping: Server<undefined> = Bun.serve({
      port: 0,
      fetch(req) {
        record(req);
        dropping.stop(true);
        return new Promise<Response>(() => {});
      },
    });

    const result = await callTool(
      serverFor(await signedIn(), 1000, dropping.url.origin),
      "get_order",
      { order_id: ORDER_ID },
    );

    expect(textOf(result)).toBe(
      `Failed to get order: GET ${ORDER_PATH} failed: network error`,
    );
    expect(received).toHaveLength(1);
  });

  test.each([["../../cart"], [""], ["7001001/cancel"], [0], [1.5], [-3]])(
    "rejects the unsafe or invalid order id %p before contacting Chowdeck",
    async (orderId) => {
      const result = await getOrder(orderId);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Input validation error");
      expect(received).toHaveLength(0);
    },
  );
});

describe("get_order_timeline", () => {
  const getTimeline = async (orderId: unknown = ORDER_ID) =>
    callTool(serverFor(await signedIn()), "get_order_timeline", {
      order_id: orderId,
    });

  test("returns only the customer-facing timeline fields, preserving observed values", async () => {
    route(`GET ${TIMELINE_PATH}`, timelineResponse());

    const result = await getTimeline();
    const text = textOf(result);
    const parsed = JSON.parse(text);

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      `GET ${TIMELINE_PATH}`,
    ]);
    expect(parsed.order_id).toBe(String(ORDER_ID));
    expect(parsed.returned).toBe(8);
    expect(parsed.timeline[0]).toEqual({
      heading: "Step 1",
      description: "MADE_PAYMENT description",
      level: "received",
      action: "MADE_PAYMENT",
      eta: null,
      time: "2026-10-01T12:00:00.000Z",
    });
    expect(
      parsed.timeline.map((e: { level: string; action: string }) => [
        e.level,
        e.action,
      ]),
    ).toEqual(OBSERVED_STEPS);
    expectNoPrivateData(text);
  });

  test("returns an empty timeline", async () => {
    route(`GET ${TIMELINE_PATH}`, timelineResponse([]));

    const result = await getTimeline();

    expect(JSON.parse(textOf(result))).toEqual({
      order_id: String(ORDER_ID),
      returned: 0,
      timeline: [],
    });
  });

  test.each([
    [
      "data is not a list",
      { message: "Successfully retrieved order timeline", data: {} },
    ],
    ["data is missing", { message: "Successfully retrieved order timeline" }],
    [
      "an entry is not an object",
      { data: [...timelineEntries(), "ORDER_COMPLETED"] },
    ],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    route(`GET ${TIMELINE_PATH}`, () => Response.json(body));

    const result = await getTimeline();

    expect(textOf(result)).toBe(
      `Failed to get order timeline: GET ${TIMELINE_PATH} returned an unexpected response shape`,
    );
  });

  test.each([
    [404, "Order not found"],
    [503, "Service Unavailable"],
  ])("reports an upstream %i as a tool error", async (status, message) => {
    route(`GET ${TIMELINE_PATH}`, () =>
      Response.json({ status: "failed", message }, { status }),
    );

    const result = await getTimeline();

    expect(textOf(result)).toBe(
      `Failed to get order timeline: GET ${TIMELINE_PATH} failed with status ${status}: ${message}`,
    );
    expect(received).toHaveLength(1);
  });

  test("reports a timeout without retrying", async () => {
    route(`GET ${TIMELINE_PATH}`, async () => {
      await Bun.sleep(300);
      return timelineResponse()();
    });

    const result = await callTool(
      serverFor(await signedIn(), 100),
      "get_order_timeline",
      { order_id: ORDER_ID },
    );

    expect(textOf(result)).toBe(
      `Failed to get order timeline: GET ${TIMELINE_PATH} timed out after 100ms`,
    );
    expect(received).toHaveLength(1);
  });
});

describe("order tools never mutate", () => {
  test("only ever send GET requests to the three observed read endpoints", async () => {
    route("GET /customer/order", orderList([orderSummary(ORDER_ID)]));
    route(`GET ${ORDER_PATH}`, orderResponse());
    route(`GET ${TIMELINE_PATH}`, timelineResponse());
    const session = await signedIn();

    await callTool(serverFor(session), "list_orders", {});
    await callTool(serverFor(session), "get_order", { order_id: ORDER_ID });
    await callTool(serverFor(session), "get_order_timeline", {
      order_id: ORDER_ID,
    });

    expectOnlyGets();
    expect(received.map((r) => r.path)).toEqual([
      "/customer/order",
      ORDER_PATH,
      TIMELINE_PATH,
    ]);
    expect(
      received.some((r) =>
        /cancel|repeat|tip|payment|complete|delivery|live-tracking/.test(
          r.path,
        ),
      ),
    ).toBe(false);
  });
});
