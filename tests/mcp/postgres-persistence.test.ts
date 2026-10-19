import { z } from "zod";
import type { Server as BunServer } from "bun";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { ChowdeckClient } from "../../lib/client";
import { createHttpApp } from "../../mcp/http-app";
import { createKeyring } from "../../lib/encryption";
import type { ServerOptions } from "../../mcp/server";
import { textResult } from "../../utils/tool-result";
import { migrate } from "../../lib/postgres/migrations";
import { createPostgresStores } from "../../lib/postgres";
import { hashToken, issueAccessToken } from "../../lib/oauth";
import { createTestDatabase, describePostgres } from "../helpers/postgres";

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
type Instance = {
  baseUrl: string;
  server: HttpServer;
  stores: ReturnType<typeof createPostgresStores>;
};

const SERVER_URL = new URL("http://localhost:2800/mcp");
const ISSUER_URL = new URL("http://localhost:2800");
const REDIRECT_URI = "https://app.example.com/oauth/callback";
const CODE_CHALLENGE = new Bun.CryptoHasher("sha256").update("v".repeat(64)).digest("base64url");
const MASTER_KEY = randomBytes(32);

let database: TestDatabase;
let chowdeck: BunServer<undefined>;
const instances: Instance[] = [];

const sessionProbe = ({ session }: ServerOptions) => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  server.registerTool("whoami", { inputSchema: z.object({}) }, async () =>
    textResult((await session?.get())?.token ?? "no session"),
  );
  return server;
};

/*
 * Each instance gets its own connection pool and store objects, standing in
 * for a restarted process or a second server sharing the same database.
 */
const startInstance = async () => {
  const stores = createPostgresStores(database.connect(), createKeyring(MASTER_KEY));
  const app = createHttpApp({
    serverUrl: SERVER_URL,
    issuerUrl: ISSUER_URL,
    ...stores,
    chowdeck: new ChowdeckClient({ baseUrl: chowdeck.url.origin, timeoutMs: 1000 }),
    authorizeLimits: { otpRequestsPerIp: 1000, otpRequestsPerPhone: 1000, otpVerificationsPerIp: 1000 },
    serverFactory: sessionProbe,
  });
  const instance = await new Promise<Instance>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server, stores });
    });
  });
  instances.push(instance);
  return instance;
};

const signIn = async (instance: Instance, clientId: string, phone: string) => {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "persist-state",
  });
  const start = await fetch(`${instance.baseUrl}/authorize?${query}`, { redirect: "manual" });
  expect(start.status).toBe(200);
  const cookie = /chowbot_authorization=[^;]+/.exec(start.headers.get("set-cookie") ?? "")![0];
  const csrf = /name="csrf_token" value="([^"]+)"/.exec(await start.text())![1]!;

  const post = (path: string, fields: Record<string, string>) =>
    fetch(`${instance.baseUrl}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ csrf_token: csrf, ...fields }).toString(),
    });

  expect((await post("/authorize/phone", { phone })).status).toBe(200);
  const verified = await post("/authorize/verify", { otp: "111111" });
  expect(verified.status).toBe(303);
  return new URL(verified.headers.get("location")!).searchParams.get("code")!;
};

const callWhoami = async (instance: Instance, token: string) => {
  const response = await fetch(`${instance.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
  });
  const text = await response.text();
  const data = text.split("\n").find((line) => line.startsWith("data: "))!;
  return JSON.parse(data.slice("data: ".length)).result.content[0].text as string;
};

describePostgres("hosted HTTP server on PostgreSQL", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    await migrate(database.connect());
    chowdeck = Bun.serve({
      port: 0,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        const body = (await req.json()) as Record<string, unknown>;
        if (path === "/auth/login") return Response.json({ status: "success" });
        return Response.json({ status: "success", data: { token: `chowdeck-token-${body.phone}` } });
      },
    });
  });

  afterAll(async () => {
    for (const { server } of instances) server.close();
    chowdeck.stop(true);
    await database.drop();
  });

  test("clients, users, sessions and codes survive a restart and are shared across instances", async () => {
    const first = await startInstance();
    const registration = await fetch(`${first.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Persistent", redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    const second = await startInstance();
    const code = await signIn(second, clientId, "08012340000");

    const third = await startInstance();
    const record = await third.stores.codes.consume(hashToken(code));
    expect(record).toMatchObject({
      clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      resource: SERVER_URL.href,
    });
    expect(await first.stores.codes.consume(hashToken(code))).toBeUndefined();

    expect(await third.stores.users.findOrCreateByPhone("08012340000")).toBe(record!.userId);
    expect(await third.stores.sessions.get(record!.userId)).toEqual({
      token: "chowdeck-token-08012340000",
      phone: "08012340000",
    });
  });

  test("bearer tokens bind each user's persisted session on any instance", async () => {
    const issuing = await startInstance();
    const registration = await fetch(`${issuing.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };

    const issueFor = async (phone: string) => {
      const code = await signIn(issuing, clientId, phone);
      const { userId } = (await issuing.stores.codes.consume(hashToken(code)))!;
      return issueAccessToken(issuing.stores.tokens, {
        userId,
        clientId,
        scopes: [],
        resource: SERVER_URL.href,
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      });
    };
    const aliceToken = await issueFor("08011112222");
    const bobToken = await issueFor("08033334444");

    const serving = await startInstance();
    expect(await callWhoami(serving, aliceToken)).toBe("chowdeck-token-08011112222");
    expect(await callWhoami(serving, bobToken)).toBe("chowdeck-token-08033334444");

    const rows = await database.connect()`SELECT token_hash FROM oauth_access_tokens`;
    expect(JSON.stringify(rows)).not.toContain(aliceToken);
  });

  test("the full browser sign-in and /token exchange works across instances", async () => {
    const authorizing = await startInstance();
    const registration = await fetch(`${authorizing.baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: [REDIRECT_URI] }),
    });
    const { client_id: clientId } = (await registration.json()) as { client_id: string };
    const code = await signIn(authorizing, clientId, "08055556666");

    const exchanging = await startInstance();
    const tokenResponse = await fetch(`${exchanging.baseUrl}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code,
        redirect_uri: REDIRECT_URI,
        code_verifier: "v".repeat(64),
        resource: SERVER_URL.href,
      }).toString(),
    });
    const issued = (await tokenResponse.json()) as { access_token: string; token_type: string };

    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("cache-control")).toBe("no-store");
    expect(issued.token_type).toBe("Bearer");

    const serving = await startInstance();
    expect(await callWhoami(serving, issued.access_token)).toBe("chowdeck-token-08055556666");

    const rows = await database.connect()`SELECT token_hash FROM oauth_access_tokens`;
    expect(JSON.stringify(rows)).not.toContain(issued.access_token);
    expect(JSON.stringify(rows)).toContain(hashToken(issued.access_token));
  });
});
