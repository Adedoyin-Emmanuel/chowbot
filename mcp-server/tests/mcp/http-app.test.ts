import { z } from "zod";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { textResult } from "../../utils/tool-result";
import type { ServerOptions } from "../../mcp/server";
import { createHttpApp } from "../../mcp/http-app";
import { InMemorySessionStore } from "../../lib/session";
import { InMemoryUserStore } from "../../lib/users";
import { InMemoryClientStore } from "../../lib/oauth-clients";
import { InMemoryAuthorizationCodeStore } from "../../lib/oauth-codes";
import {
  issueAccessToken,
  InMemoryAccessTokenStore,
  type AccessTokenRecord,
} from "../../lib/oauth";

const SERVER_URL = new URL("http://localhost:2800/mcp");
const ISSUER_URL = new URL("http://localhost:2800");
const METADATA_URL = "http://localhost:2800/.well-known/oauth-protected-resource/mcp";

type Listening = { server: HttpServer; baseUrl: string };

let tokens: InMemoryAccessTokenStore;
let sessions: InMemorySessionStore;
let factoryCalls: number;
let probeApp: Listening;
let defaultApp: Listening;

const probeServer = ({ session }: ServerOptions) => {
  factoryCalls += 1;
  const server = new McpServer({ name: "ChowBot", version: "test" });

  server.registerTool(
    "remember_phone",
    { inputSchema: z.object({ phone: z.string() }) },
    async ({ phone }) => {
      await session?.save({ ...(await session.get()), phone });
      return textResult("saved");
    },
  );
  server.registerTool("read_phone", { inputSchema: z.object({}) }, async () =>
    textResult((await session?.get())?.phone ?? "none"),
  );

  return server;
};

const listen = (app: ReturnType<typeof createHttpApp>) =>
  new Promise<Listening>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });

const issue = (overrides: Partial<AccessTokenRecord> = {}) =>
  issueAccessToken(tokens, {
    userId: "user-a",
    clientId: "client-1",
    scopes: ["mcp"],
    resource: SERVER_URL.href,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  });

const postMcp = (
  { baseUrl }: Listening,
  body: Record<string, unknown>,
  authorization?: string,
) =>
  fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(authorization && { authorization }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });

const rpcResult = async (response: Response) => {
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text).result;
};

const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const response = await postMcp(
    probeApp,
    { method: "tools/call", params: { name, arguments: args } },
    `Bearer ${token}`,
  );
  expect(response.status).toBe(200);
  return (await rpcResult(response)).content[0].text as string;
};

beforeAll(async () => {
  tokens = new InMemoryAccessTokenStore();
  sessions = new InMemorySessionStore();
  const options = {
    serverUrl: SERVER_URL,
    issuerUrl: ISSUER_URL,
    users: new InMemoryUserStore(),
    clients: new InMemoryClientStore(),
    codes: new InMemoryAuthorizationCodeStore(),
    tokens,
    sessions,
  };

  probeApp = await listen(createHttpApp({ ...options, serverFactory: probeServer }));
  defaultApp = await listen(createHttpApp(options));
});

afterAll(() => {
  probeApp.server.close();
  defaultApp.server.close();
});

beforeEach(() => {
  factoryCalls = 0;
});

describe("protected resource metadata", () => {
  test.each([
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-protected-resource",
  ])("is served at %s", async (path) => {
    const response = await fetch(`${probeApp.baseUrl}${path}`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      resource: SERVER_URL.href,
      authorization_servers: ["http://localhost:2800"],
      resource_name: "ChowBot",
    });
  });
});

describe("/mcp bearer authentication", () => {
  const listTools = { method: "tools/list", params: {} };

  test("rejects a request without a bearer token with a discoverable challenge", async () => {
    const response = await postMcp(probeApp, listTools);
    const challenge = response.headers.get("www-authenticate") ?? "";

    expect(response.status).toBe(401);
    expect(challenge).toStartWith("Bearer ");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(factoryCalls).toBe(0);
  });

  test.each([
    ["an unknown token", async () => "Bearer not-a-real-token", "Invalid access token"],
    ["a malformed header", async () => `Basic ${await issue()}`, "Invalid Authorization header format"],
    [
      "an expired token",
      async () => `Bearer ${await issue({ expiresAt: Math.floor(Date.now() / 1000) - 5 })}`,
      "Token has expired",
    ],
    [
      "a token for another resource",
      async () => `Bearer ${await issue({ resource: "https://other.example/mcp" })}`,
      "Token was not issued for this resource",
    ],
  ])("rejects %s", async (_, authorization, message) => {
    const header = await authorization();
    const response = await postMcp(probeApp, listTools, header);
    const body = await response.text();

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${METADATA_URL}"`);
    expect(body).toContain(message);
    expect(body).not.toContain(header.split(" ")[1]!);
    expect(factoryCalls).toBe(0);
  });

  test("lets a valid token reach the real ChowBot server without chat login tools", async () => {
    const response = await postMcp(defaultApp, listTools, `Bearer ${await issue()}`);
    const { tools } = await rpcResult(response);
    const names = tools.map((tool: { name: string }) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toContain("search_restaurants");
    expect(names).not.toContain("request_login_otp");
    expect(names).not.toContain("verify_login_otp");
  });

  test("advertises the ChowBot icon to clients", async () => {
    const response = await postMcp(
      defaultApp,
      {
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } },
      },
      `Bearer ${await issue()}`,
    );
    const { serverInfo } = await rpcResult(response);

    expect(serverInfo.icons).toEqual([
      { src: expect.stringMatching(/^data:image\/png;base64,/), mimeType: "image/png", sizes: ["192x192"] },
    ]);
  });

  test("binds the session of the user the token belongs to", async () => {
    const token = await issue({ userId: "user-bind" });

    expect(await callTool(token, "remember_phone", { phone: "08011111111" })).toBe("saved");

    expect(await sessions.get("user-bind")).toEqual({ phone: "08011111111" });
    expect(await callTool(token, "read_phone")).toBe("08011111111");
  });

  test("never shares session state between two authenticated users", async () => {
    const alice = await issue({ userId: "alice" });
    const bob = await issue({ userId: "bob" });

    await callTool(alice, "remember_phone", { phone: "08011111111" });
    expect(await callTool(bob, "read_phone")).toBe("none");

    await callTool(bob, "remember_phone", { phone: "08022222222" });
    expect(await callTool(alice, "read_phone")).toBe("08011111111");
    expect(await callTool(bob, "read_phone")).toBe("08022222222");
  });

  test("keeps sessions per user, not per token", async () => {
    const first = await issue({ userId: "same-user" });
    const second = await issue({ userId: "same-user" });

    await callTool(first, "remember_phone", { phone: "08033333333" });

    expect(await callTool(second, "read_phone")).toBe("08033333333");
  });
});

describe("health and shutdown", () => {
  const appWith = (lifecycle?: { isShuttingDown: () => boolean; checkDatabase: () => Promise<boolean> }) =>
    listen(
      createHttpApp({
        serverUrl: SERVER_URL,
        issuerUrl: ISSUER_URL,
        users: new InMemoryUserStore(),
        clients: new InMemoryClientStore(),
        codes: new InMemoryAuthorizationCodeStore(),
        tokens,
        sessions,
        serverFactory: probeServer,
        ...(lifecycle && { lifecycle }),
      }),
    );

  const state = { shuttingDown: false, database: true as boolean | "throws" };
  const lifecycle = {
    isShuttingDown: () => state.shuttingDown,
    checkDatabase: async () => {
      if (state.database === "throws") throw new Error("connection refused");
      return state.database;
    },
  };
  let app: Listening;

  beforeAll(async () => {
    app = await appWith(lifecycle);
  });

  afterAll(() => app.server.close());

  beforeEach(() => {
    state.shuttingDown = false;
    state.database = true;
  });

  const get = async (path: string) => {
    const response = await fetch(`${app.baseUrl}${path}`);
    return { status: response.status, body: await response.json(), cache: response.headers.get("cache-control") };
  };

  test("liveness answers without consulting the database or a token", async () => {
    state.database = "throws";

    expect(await get("/healthz")).toEqual({ status: 200, body: { status: "ok" }, cache: "no-store" });
  });

  test.each([
    ["the database answers", true, false, 200, "ready"],
    ["the database ping fails", false, false, 503, "not_ready"],
    ["the database ping throws", "throws", false, 503, "not_ready"],
    ["the server is shutting down", true, true, 503, "not_ready"],
  ] as const)("readiness when %s", async (_, database, shuttingDown, status, label) => {
    state.database = database;
    state.shuttingDown = shuttingDown;

    const result = await get("/readyz");

    expect(result.status).toBe(status);
    expect(result.body).toEqual({ status: label });
    expect(JSON.stringify(result.body)).not.toContain("connection refused");
  });

  test("refuses new MCP and OAuth requests once shutting down, before authentication or tools run", async () => {
    const token = await issue();
    state.shuttingDown = true;
    factoryCalls = 0;

    const mcp = await postMcp(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, `Bearer ${token}`);
    const metadata = await fetch(`${app.baseUrl}/.well-known/oauth-protected-resource/mcp`);

    for (const response of [mcp, metadata]) {
      expect(response.status).toBe(503);
      expect(response.headers.get("connection")).toBe("close");
    }
    expect(factoryCalls).toBe(0);
    expect((await get("/healthz")).status).toBe(200);
  });

  test("without a lifecycle the app reports ready and never refuses", async () => {
    const plain = await appWith();
    try {
      expect((await fetch(`${plain.baseUrl}/readyz`)).status).toBe(200);
      expect((await fetch(`${plain.baseUrl}/.well-known/oauth-protected-resource/mcp`)).status).toBe(200);
    } finally {
      plain.server.close();
    }
  });
});

/*
 * Behind Cloudflare and Caddy every request reaches the app from the proxy.
 * The per-address limits must key on the visitor in X-Forwarded-For, and only
 * when proxies are trusted.
 */
describe("trusted reverse proxies", () => {
  const appWith = (trustProxyHops?: number) =>
    listen(
      createHttpApp({
        serverUrl: SERVER_URL,
        issuerUrl: ISSUER_URL,
        users: new InMemoryUserStore(),
        clients: new InMemoryClientStore(),
        codes: new InMemoryAuthorizationCodeStore(),
        tokens,
        sessions,
        serverFactory: probeServer,
        authorizeLimits: { otpRequestsPerIp: 1 },
        ...(trustProxyHops !== undefined && { trustProxyHops }),
      }),
    );

  const requestCode = (app: Listening, forwardedFor: string) =>
    fetch(`${app.baseUrl}/authorize/phone`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
      body: JSON.stringify({ phone: "08012345678" }),
    }).then((response) => response.status);

  test("with trusted hops, each visitor gets their own limit", async () => {
    const app = await appWith(1);
    try {
      expect(await requestCode(app, "198.51.100.1")).not.toBe(429);
      expect(await requestCode(app, "198.51.100.2")).not.toBe(429);
      expect(await requestCode(app, "198.51.100.1")).toBe(429);
    } finally {
      app.server.close();
    }
  });

  test("without them, a forwarded address is ignored and cannot dodge the limit", async () => {
    const app = await appWith();
    try {
      expect(await requestCode(app, "198.51.100.1")).not.toBe(429);
      expect(await requestCode(app, "198.51.100.2")).toBe(429);
    } finally {
      app.server.close();
    }
  });
});
