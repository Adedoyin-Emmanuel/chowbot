import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import type { ServerContext } from "@modelcontextprotocol/server";

import { createHttpApp } from "../../mcp/http-app";
import { createKeyring } from "../../lib/encryption";
import { InMemoryUserStore } from "../../lib/users";
import { InMemorySessionStore } from "../../lib/session";
import { InMemoryClientStore } from "../../lib/oauth-clients";
import { InMemoryAuthorizationCodeStore } from "../../lib/oauth-codes";
import { resetGlobalRateLimit } from "../helpers/rate-limit";
import { issueAccessToken, InMemoryAccessTokenStore } from "../../lib/oauth";
import { createChowbotRequestStateCodec, REQUEST_STATE_TTL_SECONDS } from "../../lib/request-state";

const keyring = createKeyring(randomBytes(32));
const codec = createChowbotRequestStateCodec(keyring.requestStateKey);

const contextFor = (userId: string, method = "tools/call") =>
  ({ mcpReq: { method }, http: { authInfo: { extra: { userId } } } }) as unknown as ServerContext;

describe("ChowBot requestState codec", () => {
  afterEach(() => setSystemTime());

  test("round-trips a payload for the same user and method", async () => {
    const state = await codec.mint({ submission: "s-1", nonce: "n-1" }, contextFor("user-a"));

    expect(await codec.verify(state, contextFor("user-a"))).toEqual({ submission: "s-1", nonce: "n-1" });
    expect(state).not.toContain("user-a");
  });

  test.each([
    ["another user", contextFor("user-b")],
    ["another method", contextFor("user-a", "prompts/get")],
  ])("rejects state replayed by %s", async (_, ctx) => {
    const state = await codec.mint({ nonce: "n" }, contextFor("user-a"));

    await expect(codec.verify(state, ctx)).rejects.toThrow();
  });

  test("rejects state minted with a different key", async () => {
    const other = createChowbotRequestStateCodec(createKeyring(randomBytes(32)).requestStateKey);
    const state = await other.mint({ nonce: "n" }, contextFor("user-a"));

    await expect(codec.verify(state, contextFor("user-a"))).rejects.toThrow();
  });

  test("rejects tampered state", async () => {
    const state = await codec.mint({ nonce: "n" }, contextFor("user-a"));
    const tampered = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");

    await expect(codec.verify(tampered, contextFor("user-a"))).rejects.toThrow();
  });

  test("rejects state after its five-minute lifetime", async () => {
    const minted = new Date("2026-10-21T10:00:00Z");
    setSystemTime(minted);
    const state = await codec.mint({ nonce: "n" }, contextFor("user-a"));

    setSystemTime(new Date(minted.getTime() + (REQUEST_STATE_TTL_SECONDS - 5) * 1000));
    expect(await codec.verify(state, contextFor("user-a"))).toEqual({ nonce: "n" });

    setSystemTime(new Date(minted.getTime() + (REQUEST_STATE_TTL_SECONDS + 5) * 1000));
    await expect(codec.verify(state, contextFor("user-a"))).rejects.toThrow();
  });
});

/*
 * The production server (createServer behind createHttpApp) verifies every
 * echoed requestState before any tool runs, once http.ts supplies the codec.
 */
describe("production requestState verification over HTTP", () => {
  const SERVER_URL = new URL("http://localhost:2800/mcp");
  type Listening = { server: HttpServer; baseUrl: string };
  let tokens: InMemoryAccessTokenStore;
  let protectedApp: Listening;
  let unprotectedApp: Listening;

  const listen = (withCodec: boolean) =>
    new Promise<Listening>((resolve) => {
      const server = createHttpApp({
        serverUrl: SERVER_URL,
        issuerUrl: new URL(SERVER_URL.origin),
        users: new InMemoryUserStore(),
        clients: new InMemoryClientStore(),
        sessions: new InMemorySessionStore(),
        tokens,
        codes: new InMemoryAuthorizationCodeStore(),
        ...(withCodec && { requestStateCodec: codec }),
      }).listen(0, () => {
        const { port } = server.address() as AddressInfo;
        resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
      });
    });

  beforeAll(async () => {
    tokens = new InMemoryAccessTokenStore();
    protectedApp = await listen(true);
    unprotectedApp = await listen(false);
  });

  afterAll(() => {
    protectedApp.server.close();
    unprotectedApp.server.close();
  });

  beforeEach(resetGlobalRateLimit);

  const tokenFor = (userId: string) =>
    issueAccessToken(tokens, {
      userId,
      clientId: "client-1",
      scopes: ["mcp"],
      resource: SERVER_URL.href,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });

  const callWithState = async (target: Listening, token: string, requestState: string) => {
    const response = await fetch(`${target.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "mcp-method": "tools/call",
        "mcp-name": "list_addresses",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "list_addresses",
          arguments: {},
          requestState,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientInfo": { name: "test", version: "0" },
            "io.modelcontextprotocol/clientCapabilities": { elicitation: { form: {} } },
          },
        },
      }),
    });
    const text = await response.text();
    const data = text.split("\n").find((line) => line.startsWith("data: "));
    return JSON.parse(data ? data.slice("data: ".length) : text);
  };

  const rejected = (body: { error?: { code: number; message: string } }) => {
    expect(body.error?.code).toBe(-32602);
    expect(body.error?.message).toBe("Invalid or expired requestState");
  };

  test("rejects forged state before the tool runs", async () => {
    rejected(await callWithState(protectedApp, await tokenFor("user-a"), "v1.forged.state"));
  });

  test("rejects state minted for another user", async () => {
    const stolen = await codec.mint({ nonce: "n" }, contextFor("user-b"));

    rejected(await callWithState(protectedApp, await tokenFor("user-a"), stolen));
  });

  test("accepts the user's own valid state and runs the tool", async () => {
    const state = await codec.mint({ nonce: "n" }, contextFor("user-a"));

    const body = await callWithState(protectedApp, await tokenFor("user-a"), state);

    expect(body.error).toBeUndefined();
    expect(body.result.content[0].text).toContain("not signed in to Chowdeck");
  });

  test("without the codec, forged state would reach the tool (why http.ts must pass it)", async () => {
    const body = await callWithState(unprotectedApp, await tokenFor("user-a"), "v1.forged.state");

    expect(body.error).toBeUndefined();
    expect(body.result).toBeDefined();
  });
});
