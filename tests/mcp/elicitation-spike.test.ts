import { z } from "zod";
import {
  McpServer,
  inputRequired,
  acceptedContent,
  createRequestStateCodec,
} from "@modelcontextprotocol/server";
import {
  test,
  expect,
  describe,
  afterAll,
  beforeAll,
  beforeEach,
} from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";

import { createHttpApp } from "../../mcp/http-app";
import { InMemoryUserStore } from "../../lib/users";
import { InMemorySessionStore } from "../../lib/session";
import { InMemoryClientStore } from "../../lib/oauth-clients";
import { resetGlobalRateLimit } from "../helpers/rate-limit";
import { InMemoryAuthorizationCodeStore } from "../../lib/oauth-codes";
import { issueAccessToken, InMemoryAccessTokenStore } from "../../lib/oauth";

/*
 * Compatibility spike for the confirmation mechanism planned for live order
 * submission. It drives the real HTTP app with the exact wire messages the
 * official v2 client SDK sends on protocol revision 2026-07-28 (captured in
 * a scratch interop run): mcp-method / mcp-name / mcp-protocol-version
 * headers, the per-request _meta envelope, and inputResponses + requestState
 * on the retried round. The confirmation tool below exists only in this test.
 */

const SERVER_URL = new URL("http://localhost:2800/mcp");
const MODERN = "2026-07-28";
const CODEC_KEY = "spike-key-0123456789abcdef0123456789abcdef";

const confirmSchema = z.object({ confirm: z.boolean() });

type SpikeState = { nonce: string; item: string };

const elicitationCaps = { form: {} };
const envelope = (capabilities: Record<string, unknown>) => ({
  "io.modelcontextprotocol/protocolVersion": MODERN,
  "io.modelcontextprotocol/clientInfo": { name: "spike-client", version: "0" },
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});

/*
 * Test-only tool: refuses unless the request is modern and declares form
 * elicitation, asks for confirmation through input_required, binds state to
 * the authenticated user and the arguments, and consumes each nonce once.
 */
const spikeServerFactory = (ttlSeconds: number, consumed: Set<string>) => {
  const codec = createRequestStateCodec({
    key: CODEC_KEY,
    ttlSeconds,
    bind: (ctx) =>
      `${ctx.mcpReq.method}\0${String(ctx.http?.authInfo?.extra?.userId ?? "")}`,
  });

  return () => {
    const server = new McpServer(
      { name: "ChowBot", version: "spike" },
      { requestState: { verify: codec.verify } },
    );

    server.registerTool(
      "confirm_spike",
      { inputSchema: z.object({ item: z.string() }) },
      async ({ item }, ctx) => {
        const envelope = ctx.mcpReq.envelope as
          Record<string, unknown> | undefined;
        const caps = envelope?.[
          "io.modelcontextprotocol/clientCapabilities"
        ] as { elicitation?: { form?: unknown } } | undefined;
        if (!ctx.mcpReq.envelope || !caps?.elicitation?.form) {
          return {
            content: [{ type: "text", text: "REFUSED: client cannot confirm" }],
            isError: true,
          };
        }

        const state = ctx.mcpReq.requestState<SpikeState>();
        if (state === undefined) {
          return inputRequired({
            inputRequests: {
              confirm: inputRequired.elicit({
                message: `Confirm ${item}?`,
                requestedSchema: confirmSchema,
              }),
            },
            requestState: await codec.mint(
              { nonce: crypto.randomUUID(), item },
              ctx,
            ),
          });
        }

        if (state.item !== item) {
          return {
            content: [{ type: "text", text: "REFUSED: arguments changed" }],
            isError: true,
          };
        }
        const answer = acceptedContent(
          ctx.mcpReq.inputResponses,
          "confirm",
          confirmSchema,
        );
        if (answer?.confirm !== true) {
          return { content: [{ type: "text", text: "NOT CONFIRMED" }] };
        }
        if (consumed.has(state.nonce)) {
          return {
            content: [{ type: "text", text: "REFUSED: replay" }],
            isError: true,
          };
        }
        consumed.add(state.nonce);
        return { content: [{ type: "text", text: `CONFIRMED ${item}` }] };
      },
    );

    server.registerTool("shim_spike", { inputSchema: z.object({}) }, async () =>
      inputRequired({
        inputRequests: {
          confirm: inputRequired.elicit({
            message: "Confirm?",
            requestedSchema: confirmSchema,
          }),
        },
      }),
    );

    server.registerTool(
      "url_spike",
      { inputSchema: z.object({}) },
      async (_args, ctx) => {
        const pay = ctx.mcpReq.inputResponses?.pay as
          { action?: string } | undefined;
        if (pay) {
          return {
            content: [
              { type: "text", text: `URL ROUND DONE action=${pay.action}` },
            ],
          };
        }
        return inputRequired({
          inputRequests: {
            pay: inputRequired.elicitUrl({
              message: "Complete payment in your browser",
              url: "https://pay.example/PRIVATE-PAYMENT-LINK",
            }),
          },
        });
      },
    );

    return server;
  };
};

type Listening = { server: HttpServer; baseUrl: string };

let tokens: InMemoryAccessTokenStore;
let consumed: Set<string>;
let app: Listening;
let shortTtlApp: Listening;

const listen = (ttlSeconds: number) =>
  new Promise<Listening>((resolve) => {
    const server = createHttpApp({
      serverUrl: SERVER_URL,
      issuerUrl: new URL(SERVER_URL.origin),
      users: new InMemoryUserStore(),
      clients: new InMemoryClientStore(),
      sessions: new InMemorySessionStore(),
      tokens,
      codes: new InMemoryAuthorizationCodeStore(),
      serverFactory: spikeServerFactory(ttlSeconds, consumed),
    }).listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });

const issue = (userId: string) =>
  issueAccessToken(tokens, {
    userId,
    clientId: "client-1",
    scopes: ["mcp"],
    resource: SERVER_URL.href,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });

beforeAll(async () => {
  tokens = new InMemoryAccessTokenStore();
  consumed = new Set();
  app = await listen(600);
  shortTtlApp = await listen(1);
});

afterAll(() => {
  app.server.close();
  shortTtlApp.server.close();
});

beforeEach(async () => {
  consumed.clear();
  await resetGlobalRateLimit();
});

const parseBody = async (response: Response) => {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text);
};

type Round = {
  name?: string;
  args?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  inputResponses?: Record<string, unknown>;
  requestState?: string;
  token: string;
  target?: Listening;
};

/*
 * One modern tools/call round, shaped exactly like the v2 client's.
 */
const modernCall = async ({
  name = "confirm_spike",
  args = { item: "Fried Rice" },
  capabilities = { elicitation: elicitationCaps },
  inputResponses,
  requestState,
  token,
  target = app,
}: Round) => {
  const response = await fetch(`${target.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": MODERN,
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
        _meta: envelope(capabilities),
      },
    }),
  });
  return { status: response.status, body: await parseBody(response) };
};

const legacyCall = async (name: string, token: string) => {
  const response = await fetch(`${app.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: name === "confirm_spike" ? { item: "Fried Rice" } : {},
      },
    }),
  });
  return { status: response.status, body: await parseBody(response) };
};

const accept = { confirm: { action: "accept", content: { confirm: true } } };
const textOf = (body: { result?: { content?: { text: string }[] } }) =>
  body.result?.content?.[0]?.text;

/*
 * First round: returns the input_required result and its requestState.
 */
const firstRound = async (token: string, overrides: Partial<Round> = {}) => {
  const round = await modernCall({ token, ...overrides });
  expect(round.status).toBe(200);
  expect(round.body.result.resultType).toBe("input_required");
  return round.body.result as {
    resultType: string;
    requestState: string;
    inputRequests: Record<
      string,
      { method: string; params: Record<string, unknown> }
    >;
  };
};

describe("elicitation spike: modern 2026-07-28 round-trip through the HTTP app", () => {
  test("asks for confirmation, then completes once the user accepts", async () => {
    const token = await issue("user-a");

    const first = await firstRound(token);
    expect(first.inputRequests.confirm!.method).toBe("elicitation/create");
    expect(first.inputRequests.confirm!.params.message).toBe(
      "Confirm Fried Rice?",
    );
    expect(typeof first.requestState).toBe("string");

    const second = await modernCall({
      token,
      inputResponses: accept,
      requestState: first.requestState,
    });
    expect(second.body.result.resultType).toBe("complete");
    expect(textOf(second.body)).toBe("CONFIRMED Fried Rice");
  });

  test.each([
    ["declines", { confirm: { action: "decline" } }],
    ["cancels", { confirm: { action: "cancel" } }],
    [
      "accepts with confirm: false",
      { confirm: { action: "accept", content: { confirm: false } } },
    ],
    [
      "sends a malformed answer",
      { confirm: { action: "accept", content: { confirm: "yes" } } },
    ],
  ])("does not confirm when the user %s", async (_, inputResponses) => {
    const token = await issue("user-a");
    const first = await firstRound(token);

    const second = await modernCall({
      token,
      inputResponses,
      requestState: first.requestState,
    });

    expect(textOf(second.body)).toBe("NOT CONFIRMED");
  });

  test("an accepted answer without the echoed requestState starts over instead of confirming", async () => {
    const token = await issue("user-a");

    const round = await modernCall({ token, inputResponses: accept });

    expect(round.body.result.resultType).toBe("input_required");
  });

  test("rejects a replayed confirmation", async () => {
    const token = await issue("user-a");
    const first = await firstRound(token);

    await modernCall({
      token,
      inputResponses: accept,
      requestState: first.requestState,
    });
    const replay = await modernCall({
      token,
      inputResponses: accept,
      requestState: first.requestState,
    });

    expect(replay.body.result.isError).toBe(true);
    expect(textOf(replay.body)).toBe("REFUSED: replay");
  });

  test("refuses when the arguments change between rounds", async () => {
    const token = await issue("user-a");
    const first = await firstRound(token);

    const second = await modernCall({
      token,
      args: { item: "Jollof Rice" },
      inputResponses: accept,
      requestState: first.requestState,
    });

    expect(textOf(second.body)).toBe("REFUSED: arguments changed");
  });
});

describe("elicitation spike: requestState integrity", () => {
  const invalidState = (body: {
    error?: { code: number; message: string };
  }) => {
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toBe("Invalid or expired requestState");
  };

  test("rejects a tampered requestState before the tool runs", async () => {
    const token = await issue("user-a");
    const first = await firstRound(token);
    const tampered =
      first.requestState.slice(0, -2) +
      (first.requestState.endsWith("AA") ? "BB" : "AA");

    const second = await modernCall({
      token,
      inputResponses: accept,
      requestState: tampered,
    });

    invalidState(second.body);
    expect(consumed.size).toBe(0);
  });

  test("rejects a forged requestState", async () => {
    const token = await issue("user-a");
    const forged = `v1.${btoa(JSON.stringify({ p: { nonce: "x", item: "Fried Rice" }, exp: 9999999999 }))}.AAAA`;

    const round = await modernCall({
      token,
      inputResponses: accept,
      requestState: forged,
    });

    invalidState(round.body);
  });

  test("rejects a requestState minted for another user", async () => {
    const alice = await issue("user-a");
    const bob = await issue("user-b");
    const first = await firstRound(alice);

    const stolen = await modernCall({
      token: bob,
      inputResponses: accept,
      requestState: first.requestState,
    });

    invalidState(stolen.body);
    expect(consumed.size).toBe(0);
  });

  test("rejects an expired requestState", async () => {
    const token = await issue("user-a");
    const first = await firstRound(token, { target: shortTtlApp });

    await Bun.sleep(2100);
    const late = await modernCall({
      token,
      target: shortTtlApp,
      inputResponses: accept,
      requestState: first.requestState,
    });

    invalidState(late.body);
    expect(consumed.size).toBe(0);
  });
});

describe("elicitation spike: refusals", () => {
  test("refuses a modern client that does not declare form elicitation", async () => {
    const token = await issue("user-a");

    const round = await modernCall({ token, capabilities: {} });

    expect(round.body.result.isError).toBe(true);
    expect(textOf(round.body)).toBe("REFUSED: client cannot confirm");
  });

  test("refuses a legacy 2025-era client before asking for anything", async () => {
    const token = await issue("user-a");

    const round = await legacyCall("confirm_spike", token);

    expect(round.body.result.isError).toBe(true);
    expect(textOf(round.body)).toBe("REFUSED: client cannot confirm");
  });

  test("the SDK's legacy shim cannot elicit over per-request legacy serving", async () => {
    const token = await issue("user-a");

    const round = await legacyCall("shim_spike", token);

    expect(round.body.result.isError).toBe(true);
    expect(textOf(round.body)).toContain(
      "per-request legacy serving cannot receive server-to-client requests",
    );
  });

  test("requires authentication before any round", async () => {
    const response = await fetch(`${app.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-method": "tools/call",
        "mcp-name": "confirm_spike",
        "mcp-protocol-version": MODERN,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "confirm_spike",
          arguments: { item: "x" },
          _meta: envelope({ elicitation: elicitationCaps }),
        },
      }),
    });

    expect(response.status).toBe(401);
  });
});

describe("elicitation spike: URL mode for payment links", () => {
  test("sends the link only in the URL elicitation, never in the tool result", async () => {
    const token = await issue("user-a");
    const capabilities = { elicitation: { form: {}, url: {} } };

    const first = await modernCall({
      token,
      name: "url_spike",
      args: {},
      capabilities,
    });
    expect(first.body.result.resultType).toBe("input_required");
    const request = first.body.result.inputRequests.pay;
    expect(request.method).toBe("elicitation/create");
    expect(request.params.mode).toBe("url");
    expect(request.params.url).toBe("https://pay.example/PRIVATE-PAYMENT-LINK");

    const second = await modernCall({
      token,
      name: "url_spike",
      args: {},
      capabilities,
      inputResponses: { pay: { action: "accept" } },
    });

    expect(textOf(second.body)).toBe("URL ROUND DONE action=accept");
    expect(JSON.stringify(second.body)).not.toContain("PRIVATE-PAYMENT-LINK");
  });
});
