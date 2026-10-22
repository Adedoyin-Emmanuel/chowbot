import type { Server as BunServer } from "bun";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
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
import { registerPaymentTools } from "../../../features/payments/tools";
import { createChowbotRequestStateCodec } from "../../../lib/request-state";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";
import type { OrderSubmissionStore } from "../../../lib/order-submissions";
import { createPaymentStartConfig } from "../../../features/payments/service";

/*
 * start_payment over the real hosted stack (createHttpApp, PostgreSQL
 * stores, legacy and modern 2026-07-28 requests). Only Chowdeck is mocked.
 * The request keys (method, order_id, return_url, cancel_url) and the
 * response keys (authorization_url among them) follow the observed OPay
 * payment start; the redirect URLs are the website's own (storefront source,
 * read 2026-10-21), and the payment link is a marker that may appear only in
 * a successful start's result, never in the database or the logs.
 */

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
type Received = { method: string; path: string; authorization: string | null; body: unknown };
type Handler = () => Response | Promise<Response>;

const SERVER_URL = new URL("http://localhost:2800/mcp");
const keyring = createKeyring(randomBytes(32));
const codec = createChowbotRequestStateCodec(keyring.requestStateKey);
const TEST_CONFIG = createPaymentStartConfig();

const ORDER_ID = 7001326;
const TOTAL = 554000;
const VENDOR_ID = 102555;
const PAYMENT_LINK = "https://pay.example/checkout/PRIVATE-PAYMENT-LINK";
const START_PATH = "/customer/payment/start/v2";
const NO_CAPS = {};

let database: TestDatabase;
let sql: ReturnType<TestDatabase["connect"]>;
let stores: ReturnType<typeof createPostgresStores>;
let chowdeck: BunServer<undefined>;
let received: Received[];
let routes: Map<string, Handler[]>;
let alice: { userId: string; token: string };
let bob: { userId: string; token: string };
let logged: string[];
let errorSpy: ReturnType<typeof spyOn>;
const servers: HttpServer[] = [];

const route = (key: string, ...handlers: Handler[]) => routes.set(key, handlers);

const orderDetail = (overrides: Record<string, unknown> = {}) => () =>
  Response.json({ status: "success", data: { id: ORDER_ID, vendor_id: VENDOR_ID, status: "pending", total_price: TOTAL, created_at: new Date().toISOString(), ...overrides } });

const timeline = (actions: string[]) => () =>
  Response.json({ data: actions.map((action) => ({ heading: action, action })) });

const started = (data: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    message: "Payment successfully started",
    data: {
      processor: "opay", reference: "PRIVATE-reference", authorization_url: PAYMENT_LINK, currency: "NGN",
      amountInLowerUnits: TOTAL, status: "PRIVATE-status", display_type: "PRIVATE-display", processor_meta: {}, ...data,
    },
  });

const scriptUnpaidOrder = () => {
  route(`GET /customer/order/${ORDER_ID}`, orderDetail());
  route(`GET /customer/order/${ORDER_ID}/timeline`, timeline(["ORDER_CREATED"]));
  route(`POST ${START_PATH}`, started());
};

const posts = () => received.filter((r) => r.method === "POST" && r.path === START_PATH);
const orderReads = () => received.filter((r) => r.method === "GET" && r.path === `/customer/order/${ORDER_ID}`);

/*
 * A created, unpaid order attempt as place_order records it.
 */
const seedCreated = async (userId = alice.userId, overrides: Record<string, unknown> = {}) => {
  const [row] = await sql`INSERT INTO order_submissions ${sql({
    user_id: userId, vendor_id: VENDOR_ID, cart_id: 30742921, fee_id: 1, address_binding: "b", cart_fingerprint: "f",
    computed_total: 554000, quote_expires_at: new Date(Date.now() + 300_000), state: "created",
    payment_method_id: 4242, payment_channel_name: "opay", chowdeck_order_id: ORDER_ID,
    confirmation_consumed_at: new Date(), order_request_started_at: new Date(), ...overrides,
  })} RETURNING id`;
  return row.id as string;
};

const row = async (id: string) => (await sql`SELECT * FROM order_submissions WHERE id = ${id}`)[0];

const storeWith = (overrides: Partial<OrderSubmissionStore>): OrderSubmissionStore => {
  const real = stores.orderSubmissions;
  const proto = Object.getPrototypeOf(real);
  const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor" && typeof proto[m] === "function");
  const delegate = Object.fromEntries(methods.map((m) => [m, (real as never)[m] && ((real as never)[m] as Function).bind(real)]));
  return { ...delegate, ...overrides } as OrderSubmissionStore;
};

const startApp = async (options: { store?: OrderSubmissionStore; timeoutMs?: number } = {}) => {
  const client = new ChowdeckClient({ baseUrl: chowdeck.url.origin, timeoutMs: options.timeoutMs ?? 1000 });
  const app = createHttpApp({
    serverUrl: SERVER_URL,
    issuerUrl: new URL(SERVER_URL.origin),
    ...stores,
    orderSubmissions: options.store ?? stores.orderSubmissions,
    requestStateCodec: codec,
    paymentStartConfig: TEST_CONFIG,
    serverFactory: (opts: ServerOptions) => {
      const server = new McpServer({ name: "ChowBot", version: "test" }, { requestState: { verify: codec.verify } });
      registerPaymentTools(server, { ...opts, client });
      return server;
    },
  });
  const server = await new Promise<HttpServer>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

type Call = {
  baseUrl: string;
  quoteRef: string;
  confirmedTotal?: number;
  pocketTag?: string;
  token?: string;
  capabilities?: Record<string, unknown>;
  legacy?: boolean;
};

const call = async ({ baseUrl, quoteRef, confirmedTotal, pocketTag, token = alice.token, capabilities = NO_CAPS, legacy }: Call) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(legacy
        ? { "mcp-protocol-version": "2025-06-18" }
        : { "mcp-method": "tools/call", "mcp-name": "start_payment", "mcp-protocol-version": "2026-07-28" }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: {
        name: "start_payment",
        arguments: {
          quote_ref: quoteRef,
          ...(confirmedTotal !== undefined && { confirmed_total: confirmedTotal }),
          ...(pocketTag !== undefined && { pocket_tag: pocketTag }),
        },
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

type Report = {
  action: string;
  outcome: string;
  message: string;
  chowdeck_confirmed: string[];
  status: { order_id: number; order_state: string; source: string; detail: string } | null;
  amount?: Record<string, unknown>;
  next_step: string;
  outcome_uncertain: boolean;
  safe_to_retry: boolean;
  confirmed_total?: number;
  payment_link?: string;
  order_id?: number;
  warning?: string;
};

const reportOf = (body: { result?: { content?: { text: string }[] } }) => JSON.parse(textOf(body)) as Report;
const messageOf = (body: { result?: { content?: { text: string }[] } }) => reportOf(body).message;

/*
 * Both calls: the first shows Chowdeck's total and starts nothing; the
 * second sends that total back as confirmed_total.
 */
const pay = async (options: Call) => {
  const first = reportOf(await call(options));
  expect(first.outcome).toBe("confirmation_required");
  return call({ ...options, confirmedTotal: first.confirmed_total });
};

/*
 * A successful start: the link in the result, nothing else from Chowdeck's
 * response.
 */
const startedResult = (body: { result: { isError?: boolean; resultType?: string; content?: { text: string }[] } }) => {
  expect(body.result.isError).toBeUndefined();
  expect(body.result.resultType).not.toBe("input_required");
  expect(textOf(body)).not.toContain("PRIVATE-reference");
  expect(textOf(body)).not.toContain("PRIVATE-status");
  const report = reportOf(body);
  expect(report.action).toBe("start_payment");
  expect(report.outcome).toBe("payment_link_generated");
  expect(report.outcome_uncertain).toBe(false);
  expect(report.safe_to_retry).toBe(false);
  return report as Report & { payment_link: string; order_id: number };
};

/*
 * Anything but a successful start must not carry the link.
 */
const expectNoLink = (value: unknown) => {
  const text = JSON.stringify(value);
  expect(text).not.toContain("PRIVATE-PAYMENT-LINK");
  expect(text).not.toContain("PRIVATE-reference");
};

describePostgres("start_payment over the hosted stack (PostgreSQL)", () => {
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
        received.push({ method: req.method, path: url.pathname, authorization: req.headers.get("authorization"), body: text ? JSON.parse(text) : undefined });
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
    logged = [];
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    await sql`DELETE FROM order_submissions`;
    await resetGlobalRateLimit();
  });

  afterEach(async () => {
    errorSpy.mockRestore();
    expect(logged.join("\n")).not.toContain("PRIVATE-PAYMENT-LINK");
    const stored = await sql`SELECT row_to_json(o)::text AS json FROM order_submissions o`;
    for (const { json } of stored) expect(json).not.toContain("PRIVATE-PAYMENT-LINK");
  });

  describe("registration", () => {
    const names = (options: ServerOptions) =>
      Object.keys((createServer(options) as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    const session = { get: async () => undefined, save: async () => {}, clear: async () => {} };
    const submissions = {} as never;

    test("start_payment exists only with a store and the payment-start URLs", () => {
      expect(names({ session, submissions, requestStateCodec: codec })).not.toContain("start_payment");
      expect(names({ session, paymentStartConfig: TEST_CONFIG })).not.toContain("start_payment");
      expect(names({ session, submissions, paymentStartConfig: TEST_CONFIG })).toContain("start_payment");
    });

    test("defaults to the Chowdeck website's origin", () => {
      expect(createPaymentStartConfig()).toEqual({ origin: "https://chowdeck.com" });
    });

    test.each([["http://chowdeck.com"], ["https://chowdeck.com/store"], ["chowdeck.com"], [""]])("the configuration refuses the origin %p", (origin) => {
      expect(() => createPaymentStartConfig(origin)).toThrow("https origin");
    });
  });

  describe("a payment start", () => {
    test("confirms the order is unpaid, marks, sends the observed keys once, and returns the link", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const first = reportOf(await call({ baseUrl, quoteRef }));
      expect(first).toMatchObject({ action: "start_payment", outcome: "confirmation_required", confirmed_total: TOTAL, outcome_uncertain: false, safe_to_retry: true });
      expect(first.status?.order_state).toBe("order_created");
      expect(first.amount).toMatchObject({ total: "₦5,540.00", total_raw: TOTAL });
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();

      const result = startedResult(await call({ baseUrl, quoteRef, confirmedTotal: TOTAL }));

      expect(result).toMatchObject({ order_id: ORDER_ID, payment_link: PAYMENT_LINK });
      expect(result.status?.order_state).toBe("payment_link_generated");
      expect(result.warning).toBeUndefined();
      expect(result.message).toBe(`Open this link to pay for Chowdeck order ${ORDER_ID} with opay: ${PAYMENT_LINK}`);
      expect(result.next_step).toContain("clickable link");
      expect(result.next_step).toContain("get_order_submission");
      expect(result.next_step).toContain("ChowBot will not start another payment for this order");

      expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
        `GET /customer/order/${ORDER_ID}`,
        `GET /customer/order/${ORDER_ID}`,
        `POST ${START_PATH}`,
      ]);
      const [start] = posts();
      expect(start!.authorization).toBe("Bearer secret-token-alice");
      expect(start!.body).toEqual({
        method: "opay",
        order_id: ORDER_ID,
        return_url: `https://chowdeck.com/store/ongoing-order?orderId=${ORDER_ID}`,
        cancel_url: "https://chowdeck.com/store/checkout?status=failed",
      });

      const marked = await row(quoteRef);
      expect(marked.payment_started_at).toBeInstanceOf(Date);
      expect(marked.payment_start_state).toBe("started");
      expect(marked.state).toBe("created");
    });

    /*
     * A declared link prompt is not trusted: every client gets the link in
     * the result, so it cannot be lost after the payment started.
     */
    test.each([
      ["a client declaring URL elicitation", { capabilities: { elicitation: { form: {}, url: {} } } }],
      ["a client declaring only form elicitation", { capabilities: { elicitation: { form: {} } } }],
      ["a client without elicitation (the Claude app)", { capabilities: {} }],
      ["a legacy client", { legacy: true }],
    ])("%s gets the link in the result, after one payment start", async (_, variant) => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const result = startedResult(await pay({ baseUrl, quoteRef, ...variant }));

      expect(result.payment_link).toBe(PAYMENT_LINK);
      expect(posts()).toHaveLength(1);
      expect((await row(quoteRef)).payment_start_state).toBe("started");
    });

    test("is never started twice for an order, and the second call shows no link", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();
      startedResult(await pay({ baseUrl, quoteRef }));

      const again = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });

      expect(messageOf(again)).toContain("a payment was already started for this order; ChowBot does not start another");
      expect(reportOf(again).outcome).toBe("not_sent");
      expectNoLink(again);
      expect(posts()).toHaveLength(1);
    });

    test("sends exactly one payment start when two calls race, and only one gets the link", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const results = await Promise.all([
        call({ baseUrl, quoteRef, confirmedTotal: TOTAL }),
        call({ baseUrl, quoteRef, confirmedTotal: TOTAL }),
      ]);

      expect(posts()).toHaveLength(1);
      expect(results.filter((r) => textOf(r).includes("PRIVATE-PAYMENT-LINK"))).toHaveLength(1);
    });
  });

  /*
   * Observed 2026-10-22: every channel but OPay sends callback_url and
   * return_url (both the ongoing-order page), and Paystack's start answers
   * only authorization_url, access_code, reference and processor.
   */
  describe("channels other than OPay", () => {
    const ongoingOrder = `https://chowdeck.com/store/ongoing-order?orderId=${ORDER_ID}`;

    test.each([["card"], ["bank_transfer"], ["bank"], ["ussd"], ["zap"]])("%s sends the website's callback_url and return_url", async (channel) => {
      scriptUnpaidOrder();
      route(`POST ${START_PATH}`, () =>
        Response.json({ status: "success", data: { authorization_url: PAYMENT_LINK, access_code: "x", reference: "PRIVATE-reference", processor: "paystack" } }),
      );
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { payment_channel_name: channel });

      const result = startedResult(await pay({ baseUrl, quoteRef }));

      expect(result.payment_link).toBe(PAYMENT_LINK);
      expect(result.message).toBe(`Open this link to pay for Chowdeck order ${ORDER_ID} with ${channel}: ${PAYMENT_LINK}`);
      expect(result.amount).toEqual({ confirmed_total: "₦5,540.00" });
      expect(posts().map((p) => p.body)).toEqual([{ method: channel, order_id: ORDER_ID, callback_url: ongoingOrder, return_url: ongoingOrder }]);
    });

    test("refuses a channel ChowBot does not support, sending nothing", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { payment_channel_name: "qr" });

      expect(messageOf(await call({ baseUrl, quoteRef, confirmedTotal: TOTAL }))).toContain("payment channel is not supported");
      expect(received).toHaveLength(0);
    });

    describe("pocket", () => {
      const scriptPocket = () => {
        scriptUnpaidOrder();
        route(`POST ${START_PATH}`, started({ processor: "pocket", display_type: "inapp", processor_meta: { message: "Please open your Pocket App to complete this payment" } }));
      };

      test("asks for the Pocket tag, and refuses the second call without it, sending nothing", async () => {
        scriptPocket();
        const baseUrl = await startApp();
        const quoteRef = await seedCreated(alice.userId, { payment_channel_name: "pocket" });

        expect(reportOf(await call({ baseUrl, quoteRef })).next_step).toContain("pocket_tag");
        const refusedStart = reportOf(await call({ baseUrl, quoteRef, confirmedTotal: TOTAL }));

        expect(refusedStart.outcome).toBe("not_sent");
        expect(refusedStart.message).toContain("Pocket tag");
        expect(posts()).toHaveLength(0);
        expect((await row(quoteRef)).payment_started_at).toBeNull();
      });

      test("sends the tag without its @ and tells the user to approve in the Pocket app", async () => {
        scriptPocket();
        const baseUrl = await startApp();
        const quoteRef = await seedCreated(alice.userId, { payment_channel_name: "pocket" });

        const result = startedResult(await pay({ baseUrl, quoteRef, pocketTag: "@emmysoft" }));

        expect(posts().map((p) => p.body)).toEqual([
          { method: "pocket", order_id: ORDER_ID, callback_url: ongoingOrder, return_url: ongoingOrder, pocket_tag: "emmysoft" },
        ]);
        expect(result.message).toContain("Pocket tag emmysoft");
        expect(result.next_step).toContain("open their Pocket app");
      });

      test("refuses a malformed Pocket tag before any Chowdeck request", async () => {
        scriptPocket();
        const baseUrl = await startApp();
        const quoteRef = await seedCreated(alice.userId, { payment_channel_name: "pocket" });

        const body = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL, pocketTag: "not a tag" });

        expect(JSON.stringify(body)).toContain("Pocket tag");
        expect(received).toHaveLength(0);
      });
    });
  });

  /*
   * Observed 2026-10-22: Chowdeck reports a freshly created, unpaid order as
   * "abandoned" and lists a MADE_PAYMENT timeline step on it. Neither means
   * it was paid; such an order must still get its payment link.
   */
  test("starts the payment for an unpaid order Chowdeck reports as abandoned with a MADE_PAYMENT step", async () => {
    scriptUnpaidOrder();
    route(`GET /customer/order/${ORDER_ID}`, orderDetail({ status: "abandoned", payment: { status: "pending" } }));
    route(`GET /customer/order/${ORDER_ID}/timeline`, timeline(["ORDER_CREATED", "MADE_PAYMENT"]));
    const baseUrl = await startApp();
    const quoteRef = await seedCreated();

    const result = startedResult(await pay({ baseUrl, quoteRef }));

    expect(result.payment_link).toBe(PAYMENT_LINK);
    expect(posts()).toHaveLength(1);
    const after = await row(quoteRef);
    expect(after.state).toBe("created");
    expect(after.resolution).toBeNull();
  });

  describe("refusals before anything is sent", () => {
    test("refuses another user's attempt", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = await call({ baseUrl, quoteRef, token: bob.token });

      expect(messageOf(body)).toBe("Payment not started: that quote_ref does not exist for your account.");
      expect(reportOf(body)).toMatchObject({ outcome: "not_sent", outcome_uncertain: false, safe_to_retry: true });
      expect(received).toHaveLength(0);
    });

    test.each([
      ["an unknown outcome", { state: "unknown", chowdeck_order_id: null }],
      ["an order request not yet answered", { state: "submitting", chowdeck_order_id: null }],
    ])("refuses an attempt with %s", async (_, overrides) => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, overrides);

      const body = await call({ baseUrl, quoteRef });

      expect(messageOf(body)).toContain("only an order ChowBot created and recorded can be paid here");
      expect(received).toHaveLength(0);
    });

    test("refuses an attempt an operator marked abandoned, before any Chowdeck request", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { lock_released_at: new Date(), lock_release_reason: "operator_released" });

      const body = await call({ baseUrl, quoteRef });

      expect(messageOf(body)).toContain("this attempt was marked abandoned, so ChowBot no longer starts payments for it");
      expect(received).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();
      expect(await stores.orderSubmissions.markPaymentStarted(alice.userId, quoteRef, ORDER_ID)).toBe(false);
    });

    test("records the payment and starts nothing when Chowdeck shows the order paid", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: { status: "success" } }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = await call({ baseUrl, quoteRef });

      expect(messageOf(body)).toBe("Payment not started: Chowdeck shows this order is already paid.");
      expect(reportOf(body)).toMatchObject({ outcome: "already_paid", outcome_uncertain: false });
      expect(reportOf(body).status?.order_state).toBe("payment_confirmed");
      expect(posts()).toHaveLength(0);
      const paid = await row(quoteRef);
      expect(paid.state).toBe("paid");
      expect(paid.payment_started_at).toBeNull();
    });

    test.each([
      ["404", () => Response.json({ message: "Order not found" }, { status: 404 })],
      ["a server error", () => Response.json({ message: "Server Error" }, { status: 500 })],
    ])("starts nothing when the unpaid-order check returns %s", async (_, reply) => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, reply);
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = await call({ baseUrl, quoteRef });

      expect(messageOf(body)).toContain(`could not confirm with Chowdeck that order ${ORDER_ID} is unpaid`);
      expect(reportOf(body).status?.order_state).toBe("unknown");
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();
    });

    test("starts nothing when the marker cannot be written", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp({ store: storeWith({ markPaymentStarted: async () => { throw new Error("connection lost"); } }) });
      const quoteRef = await seedCreated();

      const body = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });

      expect(messageOf(body)).toContain("could not confirm it was safe to start the payment, so nothing was sent");
      expect(posts()).toHaveLength(0);
    });
  });

  describe("payment-start outcomes", () => {
    test("a definite rejection is recorded, not echoed verbatim, and never retried", async () => {
      scriptUnpaidOrder();
      route(`POST ${START_PATH}`, () => Response.json({ status: "failed", message: "Order already paid" }, { status: 422 }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = await pay({ baseUrl, quoteRef });

      expect(messageOf(body)).toBe("Payment not started: Chowdeck refused to start the payment (status 422). ChowBot will not try again; pay in the Chowdeck app.");
      expect(reportOf(body)).toMatchObject({ outcome: "rejected_by_chowdeck", outcome_uncertain: false, safe_to_retry: false });
      expect(textOf(body)).not.toContain("Order already paid");
      expect(body.result.isError).toBe(true);
      expectNoLink(body);
      expect((await row(quoteRef)).payment_start_state).toBe("rejected");

      const again = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });
      expect(messageOf(again)).toContain("Chowdeck refused the earlier payment start");
      expect(posts()).toHaveLength(1);
    });

    test.each([
      ["a server error", () => Response.json({ message: "Server Error" }, { status: 503 })],
      ["an expired token", () => Response.json({ message: "Token expired" }, { status: 401 })],
      ["a non-JSON body", () => new Response("<html>ok</html>", { status: 200 })],
      ["a non-success envelope", () => Response.json({ status: "pending", data: { authorization_url: PAYMENT_LINK } })],
      ["a success without a payment link", started({ authorization_url: undefined })],
      ["a success with a non-https payment link", started({ authorization_url: "http://pay.example/PRIVATE-PAYMENT-LINK" })],
      ["a success with a malformed payment link", started({ authorization_url: "PRIVATE-PAYMENT-LINK" })],
      ["a success with a javascript: payment link", started({ authorization_url: "javascript:alert('PRIVATE-PAYMENT-LINK')" })],
      ["a success with credentials in the payment link", started({ authorization_url: "https://user:pass@pay.example/PRIVATE-PAYMENT-LINK" })],
      ["a success with a non-string payment link", started({ authorization_url: { href: PAYMENT_LINK } })],
    ])("treats %s as an unknown outcome, never retries, and never shows a link", async (_, reply) => {
      scriptUnpaidOrder();
      route(`POST ${START_PATH}`, reply);
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = await pay({ baseUrl, quoteRef });

      expect(messageOf(body)).toContain("The payment start's outcome is unknown");
      expect(messageOf(body)).toContain("so you do not pay twice");
      expect(reportOf(body)).toMatchObject({ outcome: "unknown_outcome", outcome_uncertain: true, safe_to_retry: false });
      expectNoLink(body);
      expect((await row(quoteRef)).payment_start_state).toBe("unknown");

      const again = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });
      expect(messageOf(again)).toContain("an earlier payment start for this order has an unknown outcome");
      expect(posts()).toHaveLength(1);
    });

    test("treats a timeout as an unknown outcome without retrying", async () => {
      scriptUnpaidOrder();
      route(`POST ${START_PATH}`, async () => {
        await Bun.sleep(400);
        return started()();
      });
      const baseUrl = await startApp({ timeoutMs: 200 });
      const quoteRef = await seedCreated();

      const body = await pay({ baseUrl, quoteRef });

      expect(messageOf(body)).toContain("timed out after 200ms");
      expect(messageOf(body)).toContain("The payment start's outcome is unknown");
      expectNoLink(body);
      expect(posts()).toHaveLength(1);
      expect((await row(quoteRef)).payment_start_state).toBe("unknown");

      const again = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });
      expect(messageOf(again)).toContain("an earlier payment start for this order has an unknown outcome");
      expect(posts()).toHaveLength(1);
    });

    test("still offers the link when its outcome cannot be saved, and blocks any later start", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp({ store: storeWith({ recordPaymentStart: async () => { throw new Error("down"); } }) });
      const quoteRef = await seedCreated();

      const result = startedResult(await pay({ baseUrl, quoteRef }));

      expect(result.payment_link).toBe(PAYMENT_LINK);
      const inFlight = await row(quoteRef);
      expect(inFlight.payment_started_at).toBeInstanceOf(Date);
      expect(inFlight.payment_start_state).toBeNull();

      const again = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });
      expect(messageOf(again)).toContain("was sent but its outcome was not recorded");
      expect(posts()).toHaveLength(1);
    });
  });

  describe("the amount confirmation", () => {
    test("refuses, marking and sending nothing, when Chowdeck's total changed since it was confirmed", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail(), orderDetail({ total_price: 489000 }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const first = reportOf(await call({ baseUrl, quoteRef }));
      const body = await call({ baseUrl, quoteRef, confirmedTotal: first.confirmed_total });

      expect(reportOf(body)).toMatchObject({ outcome: "not_sent", safe_to_retry: true });
      expect(messageOf(body)).toContain("Chowdeck's order total is now ₦4,890.00, not the ₦5,540.00 that was confirmed");
      expect(reportOf(body).next_step).toContain("confirmed_total: 489000");
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();
    });

    test("refuses a confirmed_total the order record never showed", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = await call({ baseUrl, quoteRef, confirmedTotal: 1 });

      expect(reportOf(body).outcome).toBe("not_sent");
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();
    });

    test.each([
      ["no total_price", { total_price: undefined }],
      ["a non-numeric total_price", { total_price: "554000" }],
    ])("refuses, sending nothing, when the order record has %s", async (_, overrides) => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail(overrides));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      for (const confirmedTotal of [undefined, TOTAL]) {
        const body = await call({ baseUrl, quoteRef, confirmedTotal });
        expect(reportOf(body).outcome).toBe("not_sent");
        expect(messageOf(body)).toContain("shows no total");
      }
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();
    });

    test("shows Chowdeck's total and discounts before payment", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ total_price: 636000, promo_code_price: 65000, discount_price: 65000, promo_codes: "5FOR5", delivery_price: 65000 }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const first = reportOf(await call({ baseUrl, quoteRef }));

      expect(first.outcome).toBe("confirmation_required");
      expect(first.status?.order_state).toBe("order_created");
      expect(first.status?.source).toContain("Chowdeck's order record");
      expect(first.confirmed_total).toBe(636000);
      expect(first.amount).toMatchObject({
        total: "₦6,360.00",
        total_raw: 636000,
        discounts: { promo_code_price: "₦650.00", discount_price: "₦650.00" },
        promo_codes: "5FOR5",
      });
      expect(first.next_step).toContain("including the discounts listed");
      expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([`GET /customer/order/${ORDER_ID}`]);
    });

    test("returns no warning when the payment page amount matches the confirmed total", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const result = startedResult(await pay({ baseUrl, quoteRef }));

      expect(result.warning).toBeUndefined();
      expect(result.amount).toEqual({ confirmed_total: "₦5,540.00", payment_page_amount: "₦5,540.00" });
    });

    test("still returns the link, with a warning, when the payment page amount differs", async () => {
      scriptUnpaidOrder();
      route(`POST ${START_PATH}`, started({ amountInLowerUnits: 600000 }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const result = startedResult(await pay({ baseUrl, quoteRef }));

      expect(result.payment_link).toBe(PAYMENT_LINK);
      expect(result.warning).toContain("₦6,000.00");
      expect(result.warning).toContain("₦5,540.00");
      expect(posts()).toHaveLength(1);
    });
  });

  describe("orders Chowdeck does not show as payable", () => {
    test.each([
      ["a payment status ChowBot does not understand", { payment: { status: "refunded" } }],
      ["a payment confirmation time without a successful payment", { time_payment_confirmed: "2026-10-22T12:00:00.000Z" }],
    ])("refuses, sending nothing, for %s", async (_, overrides) => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail(overrides));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      for (const confirmedTotal of [undefined, TOTAL]) {
        const body = reportOf(await call({ baseUrl, quoteRef, confirmedTotal }));
        expect(body.outcome).toBe("not_sent");
        expect(body.status?.order_state).toBe("unknown");
        expect(body.message).toContain("cannot confirm the order is unpaid");
      }
      expect(posts()).toHaveLength(0);
      const after = await row(quoteRef);
      expect(after.payment_started_at).toBeNull();
      expect(after.state).toBe("created");
    });

    test("refuses, sending nothing, when the order record shows it cancelled", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ status: "cancelled" }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated();

      const body = reportOf(await call({ baseUrl, quoteRef, confirmedTotal: TOTAL }));

      expect(body.outcome).toBe("not_sent");
      expect(body.status?.order_state).toBe("cancelled");
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).payment_started_at).toBeNull();
    });

    test("refuses an attempt with a cancellation sent, before any Chowdeck request", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { cancel_requested_at: new Date(), cancel_request_state: "unknown" });

      const body = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });

      expect(messageOf(body)).toContain("a cancellation was sent for this order");
      expect(received).toHaveLength(0);
      expect(await stores.orderSubmissions.markPaymentStarted(alice.userId, quoteRef, ORDER_ID)).toBe(false);
    });

    test("refuses a cancelled attempt, before any Chowdeck request", async () => {
      scriptUnpaidOrder();
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { state: "cancelled", resolution: "cancelled_verified" });

      const body = await call({ baseUrl, quoteRef, confirmedTotal: TOTAL });

      expect(messageOf(body)).toContain("cancelled");
      expect(reportOf(body).outcome).toBe("not_sent");
      expect(received).toHaveLength(0);
    });
  });

  describe("an attempt ChowBot recorded as paid", () => {
    test("reads Chowdeck again and reports the payment it still shows, starting nothing", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: { status: "success" } }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { state: "paid", resolution: "paid_verified" });

      const body = reportOf(await call({ baseUrl, quoteRef, confirmedTotal: TOTAL }));

      expect(body).toMatchObject({ outcome: "already_paid", outcome_uncertain: false });
      expect(body.status?.order_state).toBe("payment_confirmed");
      expect(orderReads()).toHaveLength(1);
      expect(posts()).toHaveLength(0);
    });

    test("reports what Chowdeck shows now, as uncertain, when it no longer shows the payment", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, orderDetail({ payment: { status: "refunded" } }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { state: "paid", resolution: "paid_verified" });

      const body = reportOf(await call({ baseUrl, quoteRef, confirmedTotal: TOTAL }));

      expect(body).toMatchObject({ outcome: "not_sent", outcome_uncertain: true });
      expect(body.status?.order_state).toBe("unknown");
      expect(orderReads()).toHaveLength(1);
      expect(posts()).toHaveLength(0);
      expect((await row(quoteRef)).state).toBe("paid");
    });

    test("reports an unknown state when Chowdeck cannot be read, starting nothing", async () => {
      scriptUnpaidOrder();
      route(`GET /customer/order/${ORDER_ID}`, () => Response.json({ message: "Server Error" }, { status: 500 }));
      const baseUrl = await startApp();
      const quoteRef = await seedCreated(alice.userId, { state: "paid", resolution: "paid_verified" });

      const body = reportOf(await call({ baseUrl, quoteRef }));

      expect(body).toMatchObject({ outcome: "not_sent", outcome_uncertain: true });
      expect(body.status?.order_state).toBe("unknown");
      expect(posts()).toHaveLength(0);
    });
  });
});
