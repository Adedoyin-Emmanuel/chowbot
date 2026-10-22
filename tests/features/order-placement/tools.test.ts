import type { Server as BunServer } from "bun";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { ChowdeckClient } from "../../../lib/client";
import { createHttpApp } from "../../../mcp/http-app";
import { createKeyring } from "../../../lib/encryption";
import { issueAccessToken } from "../../../lib/oauth";
import { registerClient } from "../../../lib/oauth-clients";
import { migrate } from "../../../lib/postgres/migrations";
import { createPostgresStores } from "../../../lib/postgres";
import { createServer, type ServerOptions } from "../../../mcp/server";
import { resetGlobalRateLimit } from "../../helpers/rate-limit";
import { createChowbotRequestStateCodec } from "../../../lib/request-state";
import { registerCheckoutTools } from "../../../features/checkout/tools";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";
import type { OrderSubmissionStore } from "../../../lib/order-submissions";
import { registerOrderPlacementTools } from "../../../features/order-placement/tools";
import { CAPTURED_PAYMENT_CHANNEL_QUERY } from "../../../features/order-placement/channels";
import { createDrizzle } from "../../../lib/postgres/database";
import { PostgresRecoveryStore } from "../../../lib/postgres/recovery";
import { createGracefulShutdown } from "../../../lib/lifecycle";

/*
 * End-to-end placement over the real hosted stack: createHttpApp, the
 * PostgreSQL stores (sessions, tokens, order submissions), the production
 * requestState codec, and modern 2026-07-28 rounds shaped like the official
 * client's. Only Chowdeck is mocked. The payment-channel query is the one
 * captured from the website on 2026-10-21 (methods empty, country NG).
 */

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
type Received = { method: string; path: string; query: URLSearchParams; authorization: string | null; body: unknown };
type Handler = () => Response | Promise<Response>;

const SERVER_URL = new URL("http://localhost:2800/mcp");
const keyring = createKeyring(randomBytes(32));
const codec = createChowbotRequestStateCodec(keyring.requestStateKey);
const CHANNEL_QUERY = CAPTURED_PAYMENT_CHANNEL_QUERY;

const ADDRESS_ID = 918273;
const VENDOR_ADDRESS_ID = 645372;
const FEE_ID = 99887766;
const OPAY_CHANNEL_ID = 4242;
const ORDER_ID = 7001326;
const PACK_1 = "pack-2a74396b-8d91-54d8-97ae-912b71e15ec5";
const PACK_2 = "pack-dc9e6e30-55a3-5456-88f6-715bddd70e2e";

let database: TestDatabase;
let sql: ReturnType<TestDatabase["connect"]>;
let stores: ReturnType<typeof createPostgresStores>;
let chowdeck: BunServer<undefined>;
let received: Received[];
let routes: Map<string, Handler[]>;
let alice: { userId: string; token: string };
let bob: { userId: string; token: string };
const servers: HttpServer[] = [];

const route = (key: string, ...handlers: Handler[]) => routes.set(key, handlers);

const packRows = (pack: string, ids: [number, number, number]) => [
  { id: ids[0], item_id: 880557, name: "Fried Rice", type: "menu", quantity: 1, price_per_quantity: 180000, group_name: null, menu_group_id: null, pack_reference: pack },
  { id: ids[1], item_id: 4294037, name: "Fried Rice (Regular)", type: "group", quantity: 1, price_per_quantity: 0, group_name: "Size", menu_group_id: 5844769, pack_reference: pack },
  { id: ids[2], item_id: 4366226, name: "Take-away pack", type: "group", quantity: 1, price_per_quantity: 40000, group_name: "Packaging", menu_group_id: 5844771, pack_reference: pack },
];

const cart = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: {
      id: 30742921, vendor_id: 102555, status: "active", currency: "NGN", total_price: 440000, is_valid: true,
      validation_result: [], bag_quantity: 0, customer_vendor_note: null, customer_delivery_note: null,
      vendor: { id: 102555, name: "Chicken Republic - Opebi" },
      cart_items: [...packRows(PACK_1, [130161037, 130161038, 130161039]), ...packRows(PACK_2, [130193932, 130193933, 130193934])],
      ...overrides,
    },
  });

const addresses = (ids = [ADDRESS_ID]) => () =>
  Response.json({ status: "success", data: ids.map((id) => ({ id, pretty_name: "Home", street: "PRIVATE-street" })) });

const vendor = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: {
      id: 102555, name: "Chicken Republic - Opebi", address_id: VENDOR_ADDRESS_ID, minimum_order_amount: 250000,
      is_open: true, current_is_open_state: true, is_closed_by_operations: false, is_temporarily_unavailable: false,
      self_delivery: false, currency: "NGN", ...overrides,
    },
  });

const quote = () =>
  Response.json({
    status: "success",
    data: { id: FEE_ID, amount: 70000, final_delivery_amount: 70000, service_amount: 44000, final_service_amount: 44000, small_order_amount: 0, safety_fee: 0, currency: "NGN", distance: "PRIVATE-distance" },
  });

const gateQuote = () =>
  Response.json({ status: "success", data: { id: FEE_ID + 1, final_delivery_amount: 70000, final_service_amount: 44000 } });

const channels = (overrides: Record<string, unknown>[] = []) => () =>
  Response.json({
    status: "success",
    message: "Payment channels retrieved successfully",
    data: overrides.length > 0 ? overrides : [
      { id: 11, name: "card", processor: "paystack", is_active: 1 },
      { id: OPAY_CHANNEL_ID, name: "opay", processor: "opay", is_active: 1 },
      { id: 12, name: "ussd", processor: "paystack", is_active: 1 },
    ],
  });

const orderCreated = (data: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    message: "Order successfully saved",
    data: {
      id: ORDER_ID, reference: "PRIVATE-reference", delivery_price: 70000, tip_amount: 0, made_payment: false,
      should_pop_up_survey: false, pay_for_me_url: null, delivery_pin: 4821, tracking_url: "https://track.example/PRIVATE-tracking",
      currency: "NGN", class: "delivery", type: "single", ...data,
    },
  });

const orderDetail = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    data: { id: ORDER_ID, vendor_id: 102555, status: "pending", created_at: new Date().toISOString(), payment: { status: "pending", amount: 554000 }, order_pin: "PRIVATE-pin", ...overrides },
  });

const timeline = (actions: string[]) => () =>
  Response.json({ message: "Successfully retrieved order timeline", data: actions.map((action) => ({ heading: action, action, level: "x", time: null })) });

const scriptHappyPath = () => {
  route("GET /customer/cart/vendor/102555", cart());
  route("GET /customer/address", addresses());
  route("GET /customer/vendor/102555", vendor());
  route("POST /customer/delivery/amount", quote, gateQuote);
  route("GET /customer/payment/channel", channels());
  route("GET /customer/payment/methods", () => Response.json({ status: "success", data: [{ type: "online_payment" }] }));
  route("POST /customer/order", orderCreated());
};

const posts = (path: string) => received.filter((r) => r.method === "POST" && r.path === path);

/*
 * A store that delegates to PostgreSQL but lets one method be replaced, to
 * inject database failures without faking the claim or the lock.
 */
const storeWith = (overrides: Partial<OrderSubmissionStore>): OrderSubmissionStore => {
  const real = stores.orderSubmissions;
  const methods = [
    "createQuote", "get", "issueConfirmation", "claim", "recordGateFailure", "markOrderRequestStarted",
    "recoverUnsent", "recordOutcome", "recordPaid", "linkOrder", "listOpen",
    "listRecentlyReleased", "markPaymentStarted", "recordPaymentStart",
  ] as const;
  const delegate = Object.fromEntries(methods.map((m) => [m, (real[m] as Function).bind(real)]));
  return { ...delegate, ...overrides } as OrderSubmissionStore;
};

type Shutdown = ReturnType<typeof createGracefulShutdown>;
let lastShutdown: { controller: Shutdown; exits: number[] } | undefined;

const startApp = async (
  options: { store?: OrderSubmissionStore; timeoutMs?: number; channelQuery?: boolean; shutdownGraceMs?: number } = {},
) => {
  const client = new ChowdeckClient({ baseUrl: chowdeck.url.origin, timeoutMs: options.timeoutMs ?? 1000 });
  let controller: Shutdown | undefined;
  const app = createHttpApp({
    ...(options.shutdownGraceMs !== undefined && {
      lifecycle: { isShuttingDown: () => controller?.isShuttingDown() ?? false, checkDatabase: async () => true },
    }),
    serverUrl: SERVER_URL,
    issuerUrl: new URL(SERVER_URL.origin),
    ...stores,
    orderSubmissions: options.store ?? stores.orderSubmissions,
    requestStateCodec: codec,
    serverFactory: (opts: ServerOptions) => {
      const server = new McpServer({ name: "ChowBot", version: "test" }, { requestState: { verify: codec.verify } });
      registerCheckoutTools(server, opts.session, client, opts.submissions);
      registerOrderPlacementTools(server, {
        ...opts,
        client,
        ...(options.channelQuery !== false && { paymentChannelQuery: CHANNEL_QUERY }),
        placeOrderEnabled: true,
      });
      return server;
    },
  });
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  if (options.shutdownGraceMs !== undefined) {
    const exits: number[] = [];
    controller = createGracefulShutdown({
      server,
      graceMs: options.shutdownGraceMs,
      exit: (code) => void exits.push(code),
      log: { info: () => {}, error: () => {} },
    });
    lastShutdown = { controller, exits };
  } else {
    servers.push(server);
  }
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

type Call = {
  baseUrl: string;
  token?: string;
  name: string;
  args: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  inputResponses?: Record<string, unknown>;
  requestState?: string;
  legacy?: boolean;
};

/*
 * place_order confirms in two calls for every client: the first returns a
 * summary and a confirmation code; the second sends the code back as the
 * confirmation argument. A test's second round (requestState plus an
 * accepted answer) is expressed that way here.
 */
const call = async ({ baseUrl, token = alice.token, name, args: given, capabilities = { elicitation: { form: {} } }, inputResponses, requestState, legacy }: Call) => {
  let args = given;
  if (name === "place_order" && requestState !== undefined) {
    const content = (inputResponses?.confirm as { content?: { acknowledge_unresolved_attempts?: boolean } } | undefined)?.content;
    args = {
      ...given,
      confirmation: requestState,
      ...(content?.acknowledge_unresolved_attempts !== undefined && { acknowledge_unresolved_attempts: content.acknowledge_unresolved_attempts }),
    };
    inputResponses = undefined;
    requestState = undefined;
  }
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(legacy
        ? { "mcp-protocol-version": "2025-06-18" }
        : { "mcp-method": "tools/call", "mcp-name": name, "mcp-protocol-version": "2026-07-28" }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name,
        arguments: args,
        ...(inputResponses && { inputResponses }),
        ...(requestState !== undefined && { requestState }),
        ...(!legacy && {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test-client", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": capabilities,
          },
        }),
      },
    }),
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text);
};

const textOf = (body: { result?: { content?: { text: string }[] } }) => body.result?.content?.[0]?.text ?? "";
const ACCEPT = { confirm: { action: "accept", content: { confirm: true } } };

const getQuoteRef = async (baseUrl: string, token = alice.token) => {
  const body = await call({ baseUrl, token, name: "get_checkout_quote", args: { restaurant_id: 102555, address_id: ADDRESS_ID } });
  const parsed = JSON.parse(textOf(body));
  expect(parsed.orderable).toBe(true);
  return parsed.quote_ref as string;
};

const placeArgs = (quoteRef: string) => ({ quote_ref: quoteRef, address_id: ADDRESS_ID, payment_channel: "opay" });

type FirstRound = {
  requestState: string;
  inputRequests: { confirm: { params: { message: string; requestedSchema: { properties: Record<string, unknown> } } } };
};

/*
 * The first place_order call: a summary and a confirmation code, nothing
 * ordered. Returned in the shape the confirmation tests read.
 */
const asFirstRound = (body: { result: { content: { text: string }[] } }): FirstRound => {
  const result = JSON.parse(body.result.content[0]!.text);
  expect(result).toMatchObject({ status: "confirmation_required", order_placed: false });
  return {
    requestState: result.confirmation,
    inputRequests: {
      confirm: {
        params: {
          message: result.summary,
          requestedSchema: {
            properties: { confirm: {}, ...(result.requires_acknowledge_unresolved_attempts && { acknowledge_unresolved_attempts: {} }) },
          },
        },
      },
    },
  };
};

const firstRound = async (baseUrl: string, quoteRef: string) =>
  asFirstRound(await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef) }));

const placeOrder = async (baseUrl: string, inputResponses: Record<string, unknown> = ACCEPT) => {
  const quoteRef = await getQuoteRef(baseUrl);
  const first = await firstRound(baseUrl, quoteRef);
  const second = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), inputResponses, requestState: first.requestState });
  return { quoteRef, first, second };
};

/*
 * Test-database cleanup only: the audit table is append-only, so its rows
 * are cleared in one transaction with the trigger briefly disabled, and
 * re-enabled before the transaction commits.
 */
const clearSubmissions = () =>
  sql.begin(async (tx) => {
    await tx`ALTER TABLE order_submission_recoveries DISABLE TRIGGER order_submission_recoveries_no_update_or_delete`;
    await tx`DELETE FROM order_submission_recoveries`;
    await tx`ALTER TABLE order_submission_recoveries ENABLE TRIGGER order_submission_recoveries_no_update_or_delete`;
    await tx`DELETE FROM order_submissions`;
  });

const row = async (id: string) => (await sql`SELECT * FROM order_submissions WHERE id = ${id}`)[0];

const PRIVATE_MARKERS = ["PRIVATE-", String(FEE_ID), String(ADDRESS_ID), String(VENDOR_ADDRESS_ID), "delivery_pin", "4821", "tracking_url", "secret-token"];
const expectNothingPrivate = (value: unknown) => {
  const text = JSON.stringify(value);
  for (const marker of PRIVATE_MARKERS) expect(text).not.toContain(marker);
};

describePostgres("order placement over the hosted stack (PostgreSQL)", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    sql = database.connect();
    await migrate(sql);
    stores = createPostgresStores(sql, keyring);
    const client = await registerClient(stores.clients, { redirect_uris: ["https://app.example.com/cb"] });
    const signIn = async (phone: string, chowdeckToken: string) => {
      const userId = await stores.users.findOrCreateByPhone(phone);
      await stores.sessions.set(userId, { token: chowdeckToken, phone });
      const token = await issueAccessToken(stores.tokens, {
        userId, clientId: client.client_id, scopes: [], resource: SERVER_URL.href, expiresAt: Math.floor(Date.now() / 1000) + 3600,
      });
      return { userId, token };
    };
    alice = await signIn("08011112222", "secret-token-alice");
    bob = await signIn("08033334444", "secret-token-bob");
    chowdeck = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        const text = await req.text();
        received.push({ method: req.method, path: url.pathname, query: url.searchParams, authorization: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined });
        const queue = routes.get(`${req.method} ${url.pathname}`);
        const handler = queue && (queue.length > 1 ? queue.shift() : queue[0]);
        return handler ? handler() : Response.json({ message: "unexpected request" }, { status: 500 });
      },
    });
  });

  afterAll(async () => {
    for (const server of servers) server.close();
    chowdeck.stop(true);
    await database.drop();
  });

  beforeEach(async () => {
    received = [];
    routes = new Map();
    await clearSubmissions();
    await resetGlobalRateLimit();
  });

  afterEach(() => {
    expect(received.some((r) => r.path.includes("/payment/start"))).toBe(false);
  });

  describe("registration", () => {
    const names = async (options: ServerOptions) => {
      const server = createServer(options);
      return Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    };
    const session = { get: async () => undefined, save: async () => {}, clear: async () => {} };
    const submissions = {} as never;

    test("place_order exists only with a store, the codec, a payment-channel query and the enablement flag", async () => {
      expect(await names({ session })).not.toContain("get_order_submission");
      const hosted = await names({ session, submissions, requestStateCodec: codec });
      expect(hosted).toEqual(expect.arrayContaining(["get_order_submission", "resolve_order_submission"]));
      expect(hosted).not.toContain("place_order");
      const configured = { session, submissions, requestStateCodec: codec, paymentChannelQuery: CHANNEL_QUERY };
      expect(await names(configured)).not.toContain("place_order");
      expect(await names({ ...configured, placeOrderEnabled: false })).not.toContain("place_order");
      expect(await names({ ...configured, placeOrderEnabled: true })).toContain("place_order");
      expect(await names({ session, submissions, paymentChannelQuery: CHANNEL_QUERY, placeOrderEnabled: true })).not.toContain("place_order");
      expect(await names({ session, submissions, requestStateCodec: codec, placeOrderEnabled: true })).not.toContain("place_order");
    });
  });

  describe("confirmation", () => {
    test("asks for confirmation with the items, address, total and channel, and sends nothing yet", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      received = [];

      const first = await firstRound(baseUrl, quoteRef);

      const message = first.inputRequests.confirm.params.message;
      expect(message).toContain("Chicken Republic - Opebi");
      expect(message).toContain("1 × Fried Rice, 1 × Fried Rice");
      expect(message).toContain("Deliver to: Home");
      expect(message).toContain("554000");
      expect(message).toContain("opay");
      expect(message).toContain("Tip: none (ChowBot does not add a tip). Restaurant note: none. Delivery note: none. Not a gift. No promo code.");
      expect(message).not.toContain("Estimated total");
      expectNothingPrivate(first);
      expect(posts("/customer/order")).toHaveLength(0);
      expect(posts("/customer/delivery/amount")).toHaveLength(0);
      const channelLookup = received.find((r) => r.path === "/customer/payment/channel")!;
      expect(channelLookup.query.toString()).toBe("methods=&country_identifier=NG");
      expect(channelLookup.authorization).toBe("Bearer secret-token-alice");
      const pending = await row(quoteRef);
      expect(pending.state).toBe("confirmation_pending");
      expect(Number(pending.payment_method_id)).toBe(OPAY_CHANNEL_ID);
    });

    test.each([
      ["a legacy client", { legacy: true }],
      ["a modern client without elicitation", { capabilities: {} }],
    ])("gives %s a summary and a confirmation code, and places nothing yet", async (_, variant) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      const body = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), ...variant });

      expect(body.result.isError).toBeUndefined();
      const result = JSON.parse(textOf(body));
      expect(result).toMatchObject({ status: "confirmation_required", order_placed: false, expires_in_seconds: 300 });
      expect(result.summary).toContain("Place this order at Chicken Republic - Opebi?");
      expect(result.summary).toContain("Total: 554000");
      expect(result.confirmation).toMatch(/^v1\./);
      expect(result.next_step).toContain("Only if they explicitly say yes");
      expect(posts("/customer/order")).toHaveLength(0);
      expect(posts("/customer/delivery/amount")).toHaveLength(1);
      expect((await row(quoteRef)).state).toBe("confirmation_pending");
      expectNothingPrivate(result);
    });

    test("a summary alone orders nothing: without the second call, the attempt just waits", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      await firstRound(baseUrl, quoteRef);

      expect(posts("/customer/order")).toHaveLength(0);
      expect((await row(quoteRef)).state).toBe("confirmation_pending");
    });

    test("rejects a tampered requestState before anything runs", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const first = await firstRound(baseUrl, quoteRef);
      const tampered = first.requestState.slice(0, -2) + (first.requestState.endsWith("AA") ? "BB" : "AA");

      const body = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), inputResponses: ACCEPT, requestState: tampered });

      expect(textOf(body)).toContain("the confirmation code is invalid, expired or not yours");
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test("refuses another user's quote_ref and an expired quote", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      const stolen = await call({ baseUrl, token: bob.token, name: "place_order", args: placeArgs(quoteRef) });
      expect(textOf(stolen)).toBe("Order not placed: that quote_ref does not exist for your account.");

      await sql`UPDATE order_submissions SET quote_expires_at = now() - interval '1 second' WHERE id = ${quoteRef}`;
      const expired = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef) });
      expect(textOf(expired)).toContain("the quote expired");
    });

    test("refuses when the channel is absent and never issues a confirmation", async () => {
      scriptHappyPath();
      route("GET /customer/payment/channel", channels([{ id: 11, name: "card", processor: "paystack", is_active: 1 }, { id: OPAY_CHANNEL_ID, name: "opay", is_active: 0 }]));
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      const body = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef) });

      expect(textOf(body)).toBe("Order not placed: the opay payment channel is not available right now.");
      expect((await row(quoteRef)).state).toBe("quoted");
    });

    test("refuses when the cart changes after confirmation was requested", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const first = await firstRound(baseUrl, quoteRef);
      route("GET /customer/cart/vendor/102555", cart({ total_price: 660000 }));

      const second = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), inputResponses: ACCEPT, requestState: first.requestState });

      expect(textOf(second)).toContain("the cart changed since the quote");
      expect(posts("/customer/order")).toHaveLength(0);
      expect(posts("/customer/delivery/amount")).toHaveLength(1);
    });
  });

  describe("submission", () => {
    test("gates once, marks, sends exactly the observed payload once, and records the order", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(second.result.isError).toBeUndefined();
      const result = JSON.parse(textOf(second));
      expect(result).toMatchObject({ order_id: ORDER_ID, quote_ref: quoteRef, payment_channel: "opay", computed_total: 554000, status: "created; awaiting payment" });
      expect(result.next_step).toContain("call start_payment with this quote_ref");
      expect(result.next_step).not.toContain("does not start payments");
      expectNothingPrivate(result);

      expect(posts("/customer/delivery/amount")).toHaveLength(2);
      const [order] = posts("/customer/order");
      expect(posts("/customer/order")).toHaveLength(1);
      expect(order!.authorization).toBe("Bearer secret-token-alice");
      expect(order!.body).toEqual({
        source: "web",
        vendor_id: 102555,
        cart_id: 30742921,
        checkout_from_cart: true,
        class: "delivery",
        fee_id: FEE_ID,
        address_id: ADDRESS_ID,
        payment_method_id: OPAY_CHANNEL_ID,
        split_payment_with_wallet: false,
        requires_delivery_pin: true,
        bag_quantity: 0,
        promo_codes: [],
        currency: "NGN",
        country_code: "NG",
        customer_vendor_note: null,
        customer_delivery_note: null,
        gift_recipient: null,
      });
      expect(order!.body).not.toHaveProperty("payment_method");
      expect(order!.body).not.toHaveProperty("order_items");
      expect(order!.body).not.toHaveProperty("tip");

      const created = await row(quoteRef);
      expect(created.state).toBe("created");
      expect(Number(created.chowdeck_order_id)).toBe(ORDER_ID);
      expect(created.order_request_started_at).toBeInstanceOf(Date);
    });

    /*
     * The website omits tip unless the user picks one, and never sends 0.
     * ChowBot offers no tip choice: a tip argument is dropped by the schema,
     * the confirmation says no tip is added, and the order carries no tip.
     */
    test("treats no tip argument as no tip, and refuses a bare number as a tip", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      const bare = await call({ baseUrl, name: "place_order", args: { ...placeArgs(quoteRef), tip: 50000 } });
      expect(bare.result.isError).toBe(true);
      expect(textOf(bare)).toContain("Input validation error");

      const { second } = await placeOrder(baseUrl);
      expect(JSON.parse(textOf(second)).order_id).toBe(ORDER_ID);
      expect(posts("/customer/order")[0]!.body).not.toHaveProperty("tip");
    });

    test("sends the gate quote before the order, and the order last", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      await placeOrder(baseUrl);

      const sequence = received.filter((r) => r.method === "POST").map((r) => r.path);
      expect(sequence).toEqual(["/customer/delivery/amount", "/customer/delivery/amount", "/customer/order"]);
    });

    test("cannot be replayed", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef, first } = await placeOrder(baseUrl);

      const replay = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), inputResponses: ACCEPT, requestState: first.requestState });

      expect(textOf(replay)).toContain("this confirmation was already used");
      expect(posts("/customer/order")).toHaveLength(1);
    });

    test("uses vendor_delivery for a restaurant that delivers itself", async () => {
      scriptHappyPath();
      route("GET /customer/vendor/102555", vendor({ self_delivery: true }));
      const baseUrl = await startApp();

      await placeOrder(baseUrl);

      expect((posts("/customer/order")[0]!.body as Record<string, unknown>).class).toBe("vendor_delivery");
    });

    test("blocks a second order from the same cart while the first is unpaid", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      await placeOrder(baseUrl);
      route("POST /customer/delivery/amount", quote, gateQuote);

      const { second } = await placeOrder(baseUrl, {
        confirm: { action: "accept", content: { confirm: true, acknowledge_unresolved_attempts: true } },
      });

      expect(textOf(second)).toContain("an earlier order attempt from this cart is unpaid");
      expect(posts("/customer/order")).toHaveLength(1);
    });
  });

  describe("A5: unresolved attempts at the same restaurant", () => {
    const seedUnresolved = () =>
      sql`INSERT INTO order_submissions ${sql({
        user_id: alice.userId, vendor_id: 102555, cart_id: 12345, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
        computed_total: 1, quote_expires_at: new Date(Date.now() + 300_000), state: "unknown",
        confirmation_consumed_at: new Date(), order_request_started_at: new Date(),
      })}`;

    test("requires a separate acknowledgement and refuses without it", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      await seedUnresolved();

      const { first, second } = await placeOrder(baseUrl);

      expect(first.inputRequests.confirm.params.message).toContain("earlier order attempt(s) at this restaurant");
      expect(Object.keys(first.inputRequests.confirm.params.requestedSchema.properties)).toEqual(["confirm", "acknowledge_unresolved_attempts"]);
      expect(textOf(second)).toBe("Order not placed: the earlier unresolved order attempts were not acknowledged.");
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test("proceeds once the user acknowledges them", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      await seedUnresolved();

      const { second } = await placeOrder(baseUrl, {
        confirm: { action: "accept", content: { confirm: true, acknowledge_unresolved_attempts: true } },
      });

      expect(JSON.parse(textOf(second)).order_id).toBe(ORDER_ID);
    });
  });

  describe("the gate quote", () => {
    test("a rejected gate frees the attempt and sends no order", async () => {
      scriptHappyPath();
      route("POST /customer/delivery/amount", quote, () => Response.json({ status: "failed", message: "Vendor is closed" }, { status: 400 }));
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(textOf(second)).toBe("Order not placed: Chowdeck rejected the order check: POST /customer/delivery/amount failed with status 400: Vendor is closed. No order was sent.");
      expect(posts("/customer/order")).toHaveLength(0);
      const failed = await row(quoteRef);
      expect(failed.failure_reason).toBe("gate_rejected");
      expect(failed.order_request_started_at).toBeNull();
    });

    test("an uncertain gate sends no order and says a fee record may exist", async () => {
      scriptHappyPath();
      route("POST /customer/delivery/amount", quote, () => Response.json({ message: "Server Error" }, { status: 503 }));
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(textOf(second)).toContain("A fee record may exist on Chowdeck, but no order was sent.");
      expect(posts("/customer/order")).toHaveLength(0);
      expect((await row(quoteRef)).failure_reason).toBe("gate_uncertain");
    });
  });

  describe("the order-request marker", () => {
    test("a failing marker write sends no order, and the unsent attempt is recoverable", async () => {
      scriptHappyPath();
      const baseUrl = await startApp({ store: storeWith({ markOrderRequestStarted: async () => { throw new Error("connection lost"); } }) });

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(textOf(second)).toContain("could not confirm it was safe to send the order, so nothing was sent");
      expect(posts("/customer/order")).toHaveLength(0);
      const pending = await row(quoteRef);
      expect(pending.state).toBe("submitting");
      expect(pending.order_request_started_at).toBeNull();
    });

    test("a marker committed with a lost acknowledgement sends no order and stays locked", async () => {
      scriptHappyPath();
      const baseUrl = await startApp({
        store: storeWith({
          markOrderRequestStarted: async (userId, id) => {
            await stores.orderSubmissions.markOrderRequestStarted(userId, id);
            throw new Error("acknowledgement lost");
          },
        }),
      });

      const { quoteRef } = await placeOrder(baseUrl);

      expect(posts("/customer/order")).toHaveLength(0);
      const locked = await row(quoteRef);
      expect(locked.state).toBe("submitting");
      expect(locked.order_request_started_at).toBeInstanceOf(Date);
    });

    test("an attempt recovered before the marker sends no order", async () => {
      scriptHappyPath();
      const baseUrl = await startApp({
        store: storeWith({
          markOrderRequestStarted: async (userId, id) => {
            await sql`UPDATE order_submissions SET state = 'failed', failure_reason = 'not_sent' WHERE id = ${id}`;
            return stores.orderSubmissions.markOrderRequestStarted(userId, id);
          },
        }),
      });

      const { second } = await placeOrder(baseUrl);

      expect(textOf(second)).toBe("Order not placed: this attempt was recovered or changed before sending. Nothing was sent.");
      expect(posts("/customer/order")).toHaveLength(0);
    });
  });

  describe("order outcomes", () => {
    test("a rejected order is reported verbatim and frees the cart", async () => {
      scriptHappyPath();
      route("POST /customer/order", () => Response.json({ status: "failed", message: "Fee expired" }, { status: 422 }));
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(textOf(second)).toBe("Order not placed: Chowdeck rejected the order: POST /customer/order failed with status 422: Fee expired. No order was created.");
      expect((await row(quoteRef)).failure_reason).toBe("order_rejected");
      expect(posts("/customer/order")).toHaveLength(1);
    });

    test.each([
      ["a server error", () => Response.json({ message: "Server Error" }, { status: 503 })],
      ["an expired token", () => Response.json({ message: "Token expired" }, { status: 401 })],
      ["a non-JSON body", () => new Response("<html>ok</html>", { status: 200 })],
      ["a success without an order id", () => Response.json({ status: "success", data: { made_payment: false } })],
      ["a non-success envelope", () => Response.json({ status: "pending", data: { id: ORDER_ID } })],
    ])("treats %s as an unknown outcome, never retries, and keeps the cart locked", async (_, reply) => {
      scriptHappyPath();
      route("POST /customer/order", reply);
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeOrder(baseUrl);

      const message = textOf(second);
      expect(message).toContain("The order's outcome is unknown");
      expect(message).toContain("Do not place it again");
      expect(posts("/customer/order")).toHaveLength(1);
      expect((await row(quoteRef)).state).toBe("unknown");
    });

    test("treats a timeout as an unknown outcome without retrying", async () => {
      scriptHappyPath();
      route("POST /customer/order", async () => {
        await Bun.sleep(400);
        return orderCreated()();
      });
      const baseUrl = await startApp({ timeoutMs: 200 });

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(textOf(second)).toContain("timed out after 200ms");
      expect(posts("/customer/order")).toHaveLength(1);
      expect((await row(quoteRef)).state).toBe("unknown");
    });
  });

  describe("R2: saving the created order", () => {
    test("retries only the local write and then records the order", async () => {
      scriptHappyPath();
      let failures = 2;
      const baseUrl = await startApp({
        store: storeWith({
          recordOutcome: async (userId, id, outcome) => {
            if (failures-- > 0) throw new Error("connection lost");
            return stores.orderSubmissions.recordOutcome(userId, id, outcome);
          },
        }),
      });

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(JSON.parse(textOf(second)).warning).toBeUndefined();
      expect((await row(quoteRef)).state).toBe("created");
      expect(posts("/customer/order")).toHaveLength(1);
    });

    test("when saving keeps failing, returns the order id with guidance and keeps the attempt locked", async () => {
      scriptHappyPath();
      const baseUrl = await startApp({ store: storeWith({ recordOutcome: async () => { throw new Error("down"); } }) });

      const { quoteRef, second } = await placeOrder(baseUrl);

      const result = JSON.parse(textOf(second));
      expect(result.order_id).toBe(ORDER_ID);
      expect(result.warning).toContain(`resolve_order_submission with outcome link_order and order_id ${ORDER_ID}`);
      const locked = await row(quoteRef);
      expect(locked.state).toBe("submitting");
      expect(locked.order_request_started_at).toBeInstanceOf(Date);
      expect(posts("/customer/order")).toHaveLength(1);
    });
  });

  describe("get_order_submission (R1 and R4)", () => {
    const status = (baseUrl: string) => call({ baseUrl, name: "get_order_submission", args: { restaurant_id: 102555 } });

    test("releases an unsent claim after the grace period, never an unknown one", async () => {
      scriptHappyPath();
      const baseUrl = await startApp({ store: storeWith({ markOrderRequestStarted: async () => { throw new Error("lost"); } }) });
      const { quoteRef: unsent } = await placeOrder(baseUrl);
      await sql`UPDATE order_submissions SET confirmation_consumed_at = now() - interval '3 minutes' WHERE id = ${unsent}`;
      await sql`INSERT INTO order_submissions ${sql({
        user_id: alice.userId, vendor_id: 102555, cart_id: 999, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
        computed_total: 1, quote_expires_at: new Date(Date.now() + 300_000), state: "unknown",
        confirmation_consumed_at: new Date(Date.now() - 3600_000), order_request_started_at: new Date(Date.now() - 3600_000),
      })}`;

      const body = await status(await startApp());

      expect((await row(unsent)).failure_reason).toBe("not_sent");
      const attempts = JSON.parse(textOf(body)).attempts;
      expect(attempts.map((a: { state: string }) => a.state)).toEqual(["unknown"]);
    });

    test.each([
      ["the order detail shows payment success", orderDetail({ payment: { status: "success" } }), timeline([]), "paid"],
      ["the timeline shows MADE_PAYMENT", orderDetail(), timeline(["ORDER_CREATED", "MADE_PAYMENT"]), "paid"],
      ["there is no payment evidence", orderDetail(), timeline(["ORDER_CREATED"]), "created"],
    ])("records payment only when %s", async (_, detail, steps, expected) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, detail);
      route(`GET /customer/order/${ORDER_ID}/timeline`, steps);

      const body = await status(baseUrl);

      expect((await row(quoteRef)).state).toBe(expected);
      expect((await row(quoteRef)).lock_released_at).toBeNull();
      expectNothingPrivate(JSON.parse(textOf(body)));
    });

    test("keeps the order created when Chowdeck cannot be reached", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, () => Response.json({ message: "Server Error" }, { status: 500 }));

      const body = await status(baseUrl);

      expect((await row(quoteRef)).state).toBe("created");
      expect(JSON.parse(textOf(body)).attempts[0].payment_check).toContain("payment could not be checked");
    });

    /*
     * Whether Chowdeck serves an unpaid order by id is not yet observed;
     * if it does not, payment can never be confirmed and the lock stays.
     */
    test.each([
      ["404", 404, "Order not found"],
      ["401", 401, "Unauthenticated"],
    ])("keeps the order created and the lock held when the order lookup returns %s", async (_, code, message) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, () => Response.json({ status: "failed", message }, { status: code }));

      const body = await status(baseUrl);

      const attempt = JSON.parse(textOf(body)).attempts[0];
      expect(attempt.payment_check).toBe(`payment could not be checked (GET /customer/order/${ORDER_ID} failed with status ${code}: ${message})`);
      expect(attempt.state).toBe("created");
      expect(received.some((r) => r.path.endsWith("/timeline"))).toBe(false);
      const locked = await row(quoteRef);
      expect(locked.state).toBe("created");
      expect(locked.lock_released_at).toBeNull();
    });

    test.each([
      ["omits payment", orderDetail({ payment: undefined })],
      ["sends a null payment", orderDetail({ payment: null })],
      ["sends a payment without a status", orderDetail({ payment: { amount: 554000 } })],
    ])("treats an order that %s as unpaid unless the timeline shows MADE_PAYMENT", async (_, detail) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, detail);
      route(`GET /customer/order/${ORDER_ID}/timeline`, timeline(["ORDER_CREATED"]));

      const unpaid = await status(baseUrl);

      expect(JSON.parse(textOf(unpaid)).attempts[0].payment_check).toBe("not paid yet (Chowdeck payment status: unknown)");
      expect((await row(quoteRef)).state).toBe("created");

      route(`GET /customer/order/${ORDER_ID}/timeline`, timeline(["ORDER_CREATED", "MADE_PAYMENT"]));
      await status(baseUrl);

      const paid = await row(quoteRef);
      expect(paid.state).toBe("paid");
      expect(paid.evidence_payment_status).toBeNull();
    });

    test("keeps the order created when the payment status is missing and the timeline cannot be read", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: undefined }));
      route(`GET /customer/order/${ORDER_ID}/timeline`, () => Response.json({ message: "Order not found" }, { status: 404 }));

      const body = await status(baseUrl);

      expect(JSON.parse(textOf(body)).attempts[0].payment_check).toContain("payment could not be checked");
      expect((await row(quoteRef)).state).toBe("created");
    });

    test("does not count the order response's made_payment as payment evidence", async () => {
      scriptHappyPath();
      route("POST /customer/order", orderCreated({ made_payment: true }));
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeOrder(baseUrl);

      expect(JSON.parse(textOf(second)).status).toBe("created; Chowdeck reports it paid");
      expect((await row(quoteRef)).state).toBe("created");
    });
  });

  describe("resolve_order_submission (R3)", () => {
    const unknownAttempt = async (baseUrl: string) => {
      scriptHappyPath();
      route("POST /customer/order", () => Response.json({ message: "Server Error" }, { status: 503 }));
      const { quoteRef } = await placeOrder(baseUrl);
      expect((await row(quoteRef)).state).toBe("unknown");
      return quoteRef;
    };
    const link = (baseUrl: string, quoteRef: string, orderId = ORDER_ID) =>
      call({ baseUrl, name: "resolve_order_submission", args: { quote_ref: quoteRef, outcome: "link_order", order_id: orderId } });

    test("links a verified order and keeps the lock", async () => {
      const baseUrl = await startApp();
      const quoteRef = await unknownAttempt(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, orderDetail());

      const body = await link(baseUrl, quoteRef);

      expect(JSON.parse(textOf(body))).toMatchObject({ order_id: ORDER_ID, state: "created" });
      const linked = await row(quoteRef);
      expect(linked.resolution).toBe("linked_user_supplied_order");
      expect(linked.lock_released_at).toBeNull();
    });

    test.each([
      ["another restaurant's order", orderDetail({ vendor_id: 555 }), "different restaurant"],
      ["an order older than the attempt", orderDetail({ created_at: "2020-01-01T00:00:00Z" }), "could not be shown to come after this attempt"],
      ["an order Chowdeck cannot confirm", () => Response.json({ status: "failed", message: "Order not found" }, { status: 404 }), "Chowdeck could not confirm that order"],
      ["an order lookup refused as unauthenticated", () => Response.json({ message: "Unauthenticated" }, { status: 401 }), "Chowdeck could not confirm that order"],
      ["an order lookup that fails upstream", () => Response.json({ message: "Server Error" }, { status: 500 }), "Chowdeck could not confirm that order"],
      ["an order without a creation time", orderDetail({ created_at: undefined }), "could not be shown to come after this attempt"],
    ])("refuses %s and keeps the lock", async (_, detail, reason) => {
      const baseUrl = await startApp();
      const quoteRef = await unknownAttempt(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, detail);

      const body = await link(baseUrl, quoteRef);

      expect(textOf(body)).toContain(reason);
      expect((await row(quoteRef)).state).toBe("unknown");
    });

    test("links an order whose payment status Chowdeck omits, recording no payment status", async () => {
      const baseUrl = await startApp();
      const quoteRef = await unknownAttempt(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: undefined }));

      const body = await link(baseUrl, quoteRef);

      expect(JSON.parse(textOf(body)).state).toBe("created");
      const linked = await row(quoteRef);
      expect(linked.evidence_payment_status).toBeNull();
      expect(linked.lock_released_at).toBeNull();
    });

    test("links a paid order as created; only get_order_submission records the payment", async () => {
      const baseUrl = await startApp();
      const quoteRef = await unknownAttempt(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: { status: "success" } }));

      await link(baseUrl, quoteRef);
      expect((await row(quoteRef)).state).toBe("created");

      await call({ baseUrl, name: "get_order_submission", args: { restaurant_id: 102555 } });
      const paid = await row(quoteRef);
      expect(paid.state).toBe("paid");
      expect(paid.lock_released_at).toBeNull();
    });

    test("refuses an attempt whose request never started, and another user's attempt", async () => {
      scriptHappyPath();
      const baseUrl = await startApp({ store: storeWith({ markOrderRequestStarted: async () => { throw new Error("lost"); } }) });
      const { quoteRef } = await placeOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, orderDetail());
      const plain = await startApp();

      expect(textOf(await link(plain, quoteRef))).toContain("only an attempt whose order request was sent");
      expect(textOf(await call({ baseUrl: plain, token: bob.token, name: "resolve_order_submission", args: { quote_ref: quoteRef, outcome: "link_order", order_id: ORDER_ID } }))).toContain("does not exist for your account");
    });
  });

  describe("abandoned attempts", () => {
    const status = (baseUrl: string) => call({ baseUrl, name: "get_order_submission", args: { restaurant_id: 102555 } });

    const releaseByOperator = async (id: string, state: "created" | "unknown", reasonCode: "user_reported_abandoned" | "user_reported_no_order") => {
      const [operator] = await sql`INSERT INTO admin_operators (name, credential_hash) VALUES (${`ops-${crypto.randomUUID().slice(0, 8)}`}, 'hash') RETURNING id`;
      const result = await new PostgresRecoveryStore(createDrizzle(sql)).release({
        submissionId: id, expectedState: state, operatorId: operator.id, reasonCode, note: "Released in a test by an operator.",
        lookup: { outcome: "not_applicable" }, disclosure: "test disclosure", duplicateRiskAcknowledged: true,
      });
      expect(result.ok).toBe(true);
    };

    const seedReleasedUnknown = async () => {
      const [row] = await sql`INSERT INTO order_submissions ${sql({
        user_id: alice.userId, vendor_id: 102555, cart_id: 12345, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
        computed_total: 1, quote_expires_at: new Date(Date.now() + 300_000), state: "unknown",
        confirmation_consumed_at: new Date(), order_request_started_at: new Date(Date.now() - 25 * 3600_000),
      })} RETURNING id`;
      await releaseByOperator(row.id, "unknown", "user_reported_no_order");
      return row.id as string;
    };

    test("get_order_submission shows it as abandoned with its last known state and reason, never as cancelled", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      await releaseByOperator(quoteRef, "created", "user_reported_abandoned");

      const body = JSON.parse(textOf(await status(baseUrl)));

      expect(body.attempts).toEqual([]);
      const [abandoned] = body.abandoned;
      expect(abandoned).toMatchObject({
        quote_ref: quoteRef, status: "abandoned", last_known_state: "created", order_id: ORDER_ID,
        reason: "user_reported_abandoned",
      });
      expect(Date.parse(abandoned.abandoned_at)).not.toBeNaN();
      expect(abandoned.guidance).toContain("marked this attempt abandoned (based on your report, not verified with Chowdeck)");
      expect(abandoned.guidance).toContain("Abandoned is not cancelled: ChowBot did not cancel anything on Chowdeck");
      expect(abandoned.guidance).toContain("may still be payable");
      expect(JSON.stringify(body)).not.toMatch(/\b(was|is|has been) cancell?ed\b/i);
      expect((await row(quoteRef)).state).toBe("created");
    });

    test.each([
      ["6 days 23 hours 59 minutes", true],
      ["7 days 1 second", false],
    ])("an attempt abandoned %s ago is still listed: %p", async (age, listed) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const id = await seedReleasedUnknown();
      await sql`UPDATE order_submissions SET lock_released_at = now() - ${age}::interval WHERE id = ${id}`;

      const body = JSON.parse(textOf(await status(baseUrl)));

      expect(body.abandoned.map((a: { quote_ref: string }) => a.quote_ref)).toEqual(listed ? [id] : []);
      if (listed) expect(body.abandoned[0].last_known_state).toBe("unknown");
    });

    test("place_order warns about a recently abandoned attempt and requires the acknowledgement", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      await seedReleasedUnknown();

      const { first, second } = await placeOrder(baseUrl);

      const message = first.inputRequests.confirm.params.message;
      expect(message).toContain("1 earlier order attempt(s) at this restaurant were marked abandoned by ChowBot support in the last 7 days");
      expect(message).toContain("Abandoned is not cancelled: ChowBot did not cancel anything on Chowdeck");
      expect(message).toContain("may still be payable");
      expect(Object.keys(first.inputRequests.confirm.params.requestedSchema.properties)).toEqual(["confirm", "acknowledge_unresolved_attempts"]);
      expect(textOf(second)).toBe("Order not placed: the earlier unresolved order attempts were not acknowledged.");
      expect(posts("/customer/order")).toHaveLength(0);
    });

    const abandonPlacedOrder = async (baseUrl: string) => {
      const { quoteRef } = await placeOrder(baseUrl);
      await releaseByOperator(quoteRef, "created", "user_reported_abandoned");
      const before = await row(quoteRef);
      const [audit] = await sql`SELECT * FROM order_submission_recoveries WHERE submission_id = ${quoteRef}`;
      return { quoteRef, before, audit };
    };
    const orderReads = () => received.filter((r) => r.method === "GET" && r.path.startsWith(`/customer/order/${ORDER_ID}`));

    test.each([
      ["the payment status is success", orderDetail({ payment: { status: "success" } }), timeline([]), "success"],
      ["the timeline shows MADE_PAYMENT", orderDetail({ payment: undefined }), timeline(["ORDER_CREATED", "MADE_PAYMENT"]), null],
    ])("records a payment found after abandonment when %s, changing nothing else", async (_, detail, steps, paymentStatus) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef, before, audit } = await abandonPlacedOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, detail);
      route(`GET /customer/order/${ORDER_ID}/timeline`, steps);

      const body = JSON.parse(textOf(await status(baseUrl)));

      expect(body.attempts).toEqual([]);
      const [abandoned] = body.abandoned;
      expect(abandoned.payment_check).toBe("payment confirmed by Chowdeck after the attempt was abandoned");
      expect(Date.parse(abandoned.paid_after_abandoned.confirmed_at)).not.toBeNaN();
      expect(abandoned.last_known_state).toBe("created");
      expect(abandoned.guidance).toContain("Chowdeck has since confirmed this order was paid");
      expect(abandoned.guidance).toContain("Do not place it again");

      const after = await row(quoteRef);
      expect(after.paid_after_release_at).toBeInstanceOf(Date);
      expect(after.paid_after_release_payment_status).toBe(paymentStatus);
      for (const column of ["state", "chowdeck_order_id", "resolution", "resolved_at", "lock_released_at", "lock_release_reason",
        "evidence_order_status", "evidence_payment_status", "evidence_checked_at", "order_request_started_at"]) {
        expect(after[column]).toEqual(before[column]);
      }
      expect(after.state).toBe("created");
      expect(after.lock_released_at).toBeInstanceOf(Date);
      const [auditAfter] = await sql`SELECT * FROM order_submission_recoveries WHERE submission_id = ${quoteRef}`;
      expect(auditAfter).toEqual(audit);
    });

    test("reads a recorded post-abandonment payment once, and later reads do not ask Chowdeck again", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await abandonPlacedOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: { status: "success" } }));
      await status(baseUrl);
      const first = (await row(quoteRef)).paid_after_release_at;
      received = [];

      const again = JSON.parse(textOf(await status(baseUrl)));
      await status(baseUrl);

      expect(orderReads()).toHaveLength(0);
      expect((await row(quoteRef)).paid_after_release_at).toEqual(first);
      expect(again.abandoned[0].paid_after_abandoned).toBeDefined();
    });

    test.each([
      ["Chowdeck shows it unpaid", orderDetail(), timeline(["ORDER_CREATED"]), "not paid yet (Chowdeck payment status: pending)"],
      ["the order lookup returns 404", () => Response.json({ message: "Order not found" }, { status: 404 }), timeline([]), "payment could not be checked"],
      ["the order lookup fails upstream", () => Response.json({ message: "Server Error" }, { status: 500 }), timeline([]), "payment could not be checked"],
      ["the timeline cannot be read", orderDetail({ payment: undefined }), () => Response.json({ message: "nope" }, { status: 404 }), "payment could not be checked"],
    ])("records nothing and keeps the uncertainty when %s", async (_, detail, steps, check) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef, before, audit } = await abandonPlacedOrder(baseUrl);
      route(`GET /customer/order/${ORDER_ID}`, detail);
      route(`GET /customer/order/${ORDER_ID}/timeline`, steps);

      const first = JSON.parse(textOf(await status(baseUrl)));
      const second = JSON.parse(textOf(await status(baseUrl)));

      for (const body of [first, second]) {
        const [abandoned] = body.abandoned;
        expect(abandoned.payment_check).toContain(check);
        expect(abandoned).not.toHaveProperty("paid_after_abandoned");
        expect(abandoned.guidance).toContain("The order may still exist and may still be payable");
        expect(JSON.stringify(body)).not.toMatch(/cancell?ed\b(?<!not cancelled)/i);
      }
      const after = await row(quoteRef);
      expect(after).toEqual({ ...before, updated_at: after.updated_at });
      expect(after.paid_after_release_at).toBeNull();
      expect((await sql`SELECT * FROM order_submission_recoveries WHERE submission_id = ${quoteRef}`)[0]).toEqual(audit);
    });

    test("does not check attempts abandoned more than 7 days ago, or abandoned attempts without an order id", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await abandonPlacedOrder(baseUrl);
      await sql`UPDATE order_submissions SET lock_released_at = now() - interval '7 days 1 second' WHERE id = ${quoteRef}`;
      const unknown = await seedReleasedUnknown();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: { status: "success" } }));
      received = [];

      const body = JSON.parse(textOf(await status(baseUrl)));

      expect(received.filter((r) => r.path.startsWith("/customer/order/"))).toHaveLength(0);
      expect((await row(quoteRef)).paid_after_release_at).toBeNull();
      expect(body.abandoned.map((a: { quote_ref: string }) => a.quote_ref)).toEqual([unknown]);
      expect(body.abandoned[0]).not.toHaveProperty("payment_check");
      expect(body.abandoned[0].guidance).toContain("An order may or may not exist for this attempt");
    });

    test("the normal payment path can never change an abandoned attempt", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await abandonPlacedOrder(baseUrl);

      const recorded = await stores.orderSubmissions.recordPaid(alice.userId, quoteRef, { orderStatus: "x", paymentStatus: "success" });

      expect(recorded).toBe(false);
      expect((await row(quoteRef)).state).toBe("created");
    });

    test("place_order stops warning once the attempt was abandoned more than 7 days ago", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const id = await seedReleasedUnknown();
      await sql`UPDATE order_submissions SET lock_released_at = now() - interval '7 days 1 second' WHERE id = ${id}`;

      const { first, second } = await placeOrder(baseUrl);

      expect(first.inputRequests.confirm.params.message).not.toContain("marked abandoned");
      expect(Object.keys(first.inputRequests.confirm.params.requestedSchema.properties)).toEqual(["confirm"]);
      expect(JSON.parse(textOf(second)).order_id).toBe(ORDER_ID);
    });
  });


  /*
   * A stop signal while an order request is out. Nothing may re-send the
   * order: a drained request records its outcome; one cut off by the grace
   * deadline keeps its marker and is reported as an unknown outcome.
   */
  describe("shutdown during an order request", () => {
    const sendOrderDuringShutdown = async (upstreamDelayMs: number, graceMs: number) => {
      scriptHappyPath();
      route("POST /customer/order", async () => {
        await Bun.sleep(upstreamDelayMs);
        return orderCreated()();
      });
      const baseUrl = await startApp({ shutdownGraceMs: graceMs, timeoutMs: 5000 });
      const { controller, exits } = lastShutdown!;
      const quoteRef = await getQuoteRef(baseUrl);
      const first = await firstRound(baseUrl, quoteRef);

      const second = call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), inputResponses: ACCEPT, requestState: first.requestState });
      while (posts("/customer/order").length === 0) await Bun.sleep(5);
      controller.shutdown("SIGTERM");
      return { quoteRef, second, exits, baseUrl };
    };

    test("drains: the order in flight completes and is recorded, sent exactly once, and new requests are refused", async () => {
      const { quoteRef, second, exits, baseUrl } = await sendOrderDuringShutdown(300, 5_000);

      const refused = await call({ baseUrl, name: "get_order_submission", args: { restaurant_id: 102555 } }).then(
        (body) => body,
        () => "connection refused",
      );
      expect(refused === "connection refused" || refused?.error === "server_shutting_down").toBe(true);

      const result = JSON.parse(textOf(await second));
      expect(result.order_id).toBe(ORDER_ID);
      expect((await row(quoteRef)).state).toBe("created");
      while (exits.length === 0) await Bun.sleep(5);
      expect(exits).toEqual([0]);
      await Bun.sleep(100);
      expect(posts("/customer/order")).toHaveLength(1);
    });

    test("grace expiry leaves the attempt sent with an unknown outcome and never re-sends the order", async () => {
      const { quoteRef, second, exits } = await sendOrderDuringShutdown(600, 100);

      while (exits.length === 0) await Bun.sleep(5);
      expect(exits[0]).toBe(1);
      const atExit = await row(quoteRef);
      expect(atExit.state).toBe("submitting");
      expect(atExit.order_request_started_at).toBeInstanceOf(Date);

      await second.catch(() => undefined);
      await Bun.sleep(100);
      expect(posts("/customer/order")).toHaveLength(1);
    });
  });

  describe("payment-start status in get_order_submission", () => {
    test.each([
      ["unknown", "unknown"],
      [null, "sent; outcome not recorded"],
    ])("shows the recorded state %p and its time, and nothing from the processor", async (recorded, shown) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const { quoteRef } = await placeOrder(baseUrl);
      await sql`UPDATE order_submissions SET payment_started_at = now(), payment_start_state = ${recorded} WHERE id = ${quoteRef}`;
      route(`GET /customer/order/${ORDER_ID}`, orderDetail());
      route(`GET /customer/order/${ORDER_ID}/timeline`, timeline(["ORDER_CREATED"]));

      const body = JSON.parse(textOf(await call({ baseUrl, name: "get_order_submission", args: { restaurant_id: 102555 } })));

      const { payment_start } = body.attempts[0];
      expect(payment_start.state).toBe(shown);
      expect(Date.parse(payment_start.started_at)).not.toBeNaN();
      expect(Object.keys(payment_start)).toEqual(["state", "started_at"]);
      expect(JSON.stringify(body)).not.toMatch(/authorization_url|reference|processor/);
    });
  });

  describe("confirmation notes", () => {
    test("shows the exact cart notes the order would carry", async () => {
      scriptHappyPath();
      route("GET /customer/cart/vendor/102555", cart({ customer_vendor_note: "No onions 🌶️", customer_delivery_note: "Blue gate" }));
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      const first = await firstRound(baseUrl, quoteRef);

      expect(first.inputRequests.confirm.params.message).toContain('Restaurant note: "No onions 🌶️". Delivery note: "Blue gate".');
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test("refuses, sending and claiming nothing, when a note changes after confirmation", async () => {
      scriptHappyPath();
      route("GET /customer/cart/vendor/102555", cart({ customer_vendor_note: "No onions" }));
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const first = await firstRound(baseUrl, quoteRef);
      route("GET /customer/cart/vendor/102555", cart({ customer_vendor_note: "Extra onions" }));

      const second = await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), inputResponses: ACCEPT, requestState: first.requestState });

      expect(textOf(second)).toBe("Order not placed: the cart's restaurant or delivery note changed after confirmation was requested. Start again to confirm the current notes.");
      expect(posts("/customer/order")).toHaveLength(0);
      expect(posts("/customer/delivery/amount")).toHaveLength(1);
      expect((await row(quoteRef)).state).toBe("confirmation_pending");
    });

    test("still places the order when the notes are unchanged", async () => {
      scriptHappyPath();
      route("GET /customer/cart/vendor/102555", cart({ customer_delivery_note: "Blue gate" }));
      const baseUrl = await startApp();

      const { second } = await placeOrder(baseUrl);

      expect(JSON.parse(textOf(second)).order_id).toBe(ORDER_ID);
      expect((posts("/customer/order")[0]!.body as Record<string, unknown>).customer_delivery_note).toBe("Blue gate");
    });
  });

  /*
   * Tip, gift and promo code: validated live at confirmation, shown to the
   * user, bound into the confirmation state and sent in the website's shape.
   */
  describe("order extras", () => {
    const tipsConfig = () =>
      Response.json({ status: "success", data: { delivery_driver_tips_config: { recommendation_percent: [5, 10, "Custom"], minimum_tip_amount: 10000, maximum_tip_amount: 500000 } } });
    const discounts = (entries: Record<string, unknown>[]) => () => Response.json({ status: "success", data: entries });
    const gift = { donor_name: "Ada", name: "Tunde Example", phone: "08012345678", message: "Enjoy!" };
    const scriptExtras = () => {
      scriptHappyPath();
      route("GET /customer/config", tipsConfig);
      route("POST /auth/phone/validate", () => Response.json({ status: "success", data: { is_valid: true } }));
      route("POST /customer/discount/apply", discounts([{ target: "menus", amount_off: 5000 }]), discounts([]));
    };
    const placeWith = async (baseUrl: string, extras: Record<string, unknown>, second: Record<string, unknown> = extras) => {
      const quoteRef = await getQuoteRef(baseUrl);
      const body = await call({ baseUrl, name: "place_order", args: { ...placeArgs(quoteRef), ...extras } });
      if (body.result.isError) return { quoteRef, first: body, summary: undefined, second: undefined };
      const parsed = JSON.parse(textOf(body));
      const result = await call({ baseUrl, name: "place_order", args: { ...placeArgs(quoteRef), ...second, confirmation: parsed.confirmation } });
      return { quoteRef, first: body, summary: parsed.summary as string, second: result };
    };

    test("confirms and sends a tip, gift and promo code exactly as the website would", async () => {
      scriptExtras();
      const baseUrl = await startApp();

      const { summary, second } = await placeWith(baseUrl, { tip: { amount_naira: 200 }, gift, promo_code: "SAVE10" });

      const message = summary!;
      expect(message).toContain("Tip: ₦200.00 for the rider.");
      expect(message).toContain('Gift for Tunde Example (phone 08012345678, NG) from Ada, message "Enjoy!".');
      expect(message).toContain("Promo code SAVE10: Chowdeck's discount calculation shows ₦50.00 off the items; the final discount is set by Chowdeck.");
      expect(message).toContain("Estimated total: ₦5,690.00 (the total above plus the tip minus the calculated discount; computed by ChowBot, not confirmed by Chowdeck).");

      const [order] = posts("/customer/order");
      expect(posts("/customer/order")).toHaveLength(1);
      expect(order!.body).toMatchObject({
        promo_codes: ["SAVE10"],
        tip: 20000,
        gift_recipient: { country_code: "NG", phone: "08012345678", donor_name: "Ada", name: "Tunde Example", message: "Enjoy!", save_as_beneficiary: false },
        payment_method_id: OPAY_CHANNEL_ID,
      });
      expect(order!.body).not.toHaveProperty("payment_method");
      expect(JSON.parse(textOf(second!))).toMatchObject({ order_id: ORDER_ID, tip: "₦200.00", promo_code: "SAVE10", gift_for: "Tunde Example" });
    });

    test("sends the same payload as before when no extras are given", async () => {
      scriptExtras();
      const baseUrl = await startApp();

      await placeWith(baseUrl, {});

      const body = posts("/customer/order")[0]!.body as Record<string, unknown>;
      expect(body.promo_codes).toEqual([]);
      expect(body.gift_recipient).toBeNull();
      expect(body).not.toHaveProperty("tip");
      expect(received.some((r) => ["/customer/config", "/auth/phone/validate", "/customer/discount/apply"].includes(r.path))).toBe(false);
    });

    test.each([
      ["a promo code with no calculated discount", { promo_code: "SAVE10" }, () => route("POST /customer/discount/apply", discounts([]), discounts([])), "Order not placed: Chowdeck's discount calculation shows no discount for the promo code SAVE10."],
      ["a refused promo code", { promo_code: "SAVE10" }, () => route("POST /customer/discount/apply", () => Response.json({ message: "Promo code has expired" }, { status: 422 })), "Order not placed: Chowdeck refused the promo code SAVE10 (POST /customer/discount/apply failed with status 422: Promo code has expired)."],
      ["an invalid gift phone", { gift }, () => route("POST /auth/phone/validate", () => Response.json({ status: "success", data: { is_valid: false } })), "Order not placed: Chowdeck says the gift recipient's phone number is not valid for that country."],
      ["a tip above the maximum", { tip: { amount_naira: 6000 } }, () => {}, "Order not placed: the tip must be at most ₦5,000.00."],
    ])("asks for nothing and places nothing with %s", async (_, extras, override, message) => {
      scriptExtras();
      override();
      const baseUrl = await startApp();

      const { quoteRef, first } = await placeWith(baseUrl, extras);

      expect(textOf(first)).toBe(message);
      expect(posts("/customer/order")).toHaveLength(0);
      expect((await row(quoteRef)).state).toBe("quoted");
    });

    test.each([
      ["a different tip", { tip: { amount_naira: 200 } }, { tip: { amount_naira: 500 } }],
      ["a dropped tip", { tip: { amount_naira: 200 } }, {}],
      ["an added promo code", {}, { promo_code: "SAVE10" }],
      ["a changed gift recipient", { gift }, { gift: { ...gift, name: "Someone Else" } }],
    ])("refuses %s at submission, sending and claiming nothing", async (_, confirmed, submitted) => {
      scriptExtras();
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeWith(baseUrl, confirmed, submitted);

      expect(textOf(second!)).toBe("Order not placed: the tip, gift or promo code differs from what was confirmed. Start again.");
      expect(posts("/customer/order")).toHaveLength(0);
      expect((await row(quoteRef)).state).toBe("confirmation_pending");
    });

    test("an unclear outcome with extras is still never retried", async () => {
      scriptExtras();
      route("POST /customer/order", () => Response.json({ message: "Server Error" }, { status: 503 }));
      const baseUrl = await startApp();

      const { quoteRef, second } = await placeWith(baseUrl, { tip: { amount_naira: 200 } });

      expect(textOf(second!)).toContain("The order's outcome is unknown");
      expect(posts("/customer/order")).toHaveLength(1);
      expect((await row(quoteRef)).state).toBe("unknown");
    });
  });

  /*
   * Two-step confirmation for clients without a confirmation prompt (the
   * Claude app). The code is the same signed state the prompt flow uses.
   */
  describe("two-step confirmation", () => {
    const firstCall = async (baseUrl: string, quoteRef: string, extra: Record<string, unknown> = {}, token = alice.token) => {
      const body = await call({ baseUrl, token, name: "place_order", args: { ...placeArgs(quoteRef), ...extra }, legacy: true });
      return JSON.parse(textOf(body)) as { confirmation: string; summary: string; requires_acknowledge_unresolved_attempts?: boolean };
    };
    const secondCall = (baseUrl: string, args: Record<string, unknown>, token = alice.token) =>
      call({ baseUrl, token, name: "place_order", args, legacy: true });

    test("does not send a prompt interaction even when the client declares form elicitation", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);

      const first = await call({
        baseUrl,
        name: "place_order",
        args: placeArgs(quoteRef),
        capabilities: { elicitation: { form: {} } },
      });

      const summary = JSON.parse(textOf(first));
      expect(summary).toMatchObject({ status: "confirmation_required", order_placed: false });
      expect(summary.summary).toContain("Chicken Republic - Opebi");
      expect(summary.summary).toContain("Deliver to: Home");
      expect(summary.summary).toContain("Total: 554000");
      expect(summary.summary).toContain("opay");
      expect(summary.confirmation).toMatch(/^v1\./);
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test.each([
      ["a legacy client", { legacy: true }],
      ["a modern client without elicitation", { capabilities: {} }],
    ])("places the order once %s sends the code back", async (_, variant) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const first = JSON.parse(textOf(await call({ baseUrl, name: "place_order", args: placeArgs(quoteRef), ...variant })));

      const second = await call({ baseUrl, name: "place_order", args: { ...placeArgs(quoteRef), confirmation: first.confirmation }, ...variant });

      expect(JSON.parse(textOf(second))).toMatchObject({ order_id: ORDER_ID, quote_ref: quoteRef, status: "created; awaiting payment" });
      expect(posts("/customer/order")).toHaveLength(1);
      expect(posts("/customer/delivery/amount")).toHaveLength(2);
      expect((await row(quoteRef)).state).toBe("created");
    });

    test("a code can be used only once", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const { confirmation } = await firstCall(baseUrl, quoteRef);
      await secondCall(baseUrl, { ...placeArgs(quoteRef), confirmation });

      const replay = await secondCall(baseUrl, { ...placeArgs(quoteRef), confirmation });

      expect(textOf(replay)).toContain("this confirmation was already used");
      expect(posts("/customer/order")).toHaveLength(1);
    });

    test.each([
      ["a tampered code", (c: string) => c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA")],
      ["a made-up code", () => "v1.eyJwIjp7fX0.AAAA"],
    ])("refuses %s and sends nothing", async (_, mutate) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const { confirmation } = await firstCall(baseUrl, quoteRef);

      const result = await secondCall(baseUrl, { ...placeArgs(quoteRef), confirmation: mutate(confirmation) });

      expect(textOf(result)).toContain("the confirmation code is invalid, expired or not yours");
      expect(posts("/customer/order")).toHaveLength(0);
      expect((await row(quoteRef)).state).toBe("confirmation_pending");
    });

    test("another user cannot use someone's code", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const { confirmation } = await firstCall(baseUrl, quoteRef);

      const result = await secondCall(baseUrl, { ...placeArgs(quoteRef), confirmation }, bob.token);

      expect(textOf(result)).toContain("the confirmation code is invalid, expired or not yours");
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test.each([
      ["a different address", { address_id: ADDRESS_ID + 1 }, "the order details changed after confirmation was requested"],
      ["an added tip", { tip: { amount_naira: 200 } }, "the tip, gift or promo code differs from what was confirmed"],
    ])("refuses the code with %s", async (_, change, message) => {
      scriptHappyPath();
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const { confirmation } = await firstCall(baseUrl, quoteRef);

      const result = await secondCall(baseUrl, { ...placeArgs(quoteRef), ...change, confirmation });

      expect(textOf(result)).toContain(message);
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test("earlier unresolved attempts still need an explicit acknowledgement", async () => {
      scriptHappyPath();
      const baseUrl = await startApp();
      await sql`INSERT INTO order_submissions ${sql({
        user_id: alice.userId, vendor_id: 102555, cart_id: 12345, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
        computed_total: 1, quote_expires_at: new Date(Date.now() + 300_000), state: "unknown",
        confirmation_consumed_at: new Date(), order_request_started_at: new Date(),
      })}`;
      const quoteRef = await getQuoteRef(baseUrl);
      const first = await firstCall(baseUrl, quoteRef);
      expect(first.requires_acknowledge_unresolved_attempts).toBe(true);
      expect(first.summary).toContain("earlier order attempt(s) at this restaurant");

      const without = await secondCall(baseUrl, { ...placeArgs(quoteRef), confirmation: first.confirmation });
      expect(textOf(without)).toBe("Order not placed: the earlier unresolved order attempts were not acknowledged.");
      expect(posts("/customer/order")).toHaveLength(0);
    });

    test("an unclear outcome is never retried", async () => {
      scriptHappyPath();
      route("POST /customer/order", () => Response.json({ message: "Server Error" }, { status: 503 }));
      const baseUrl = await startApp();
      const quoteRef = await getQuoteRef(baseUrl);
      const { confirmation } = await firstCall(baseUrl, quoteRef);

      const result = await secondCall(baseUrl, { ...placeArgs(quoteRef), confirmation });

      expect(textOf(result)).toContain("The order's outcome is unknown");
      expect(posts("/customer/order")).toHaveLength(1);
      expect((await row(quoteRef)).state).toBe("unknown");
    });
  });
});
