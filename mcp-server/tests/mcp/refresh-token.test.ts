import { z } from "zod";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import {
  test,
  spyOn,
  expect,
  describe,
  afterAll,
  beforeAll,
} from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { InMemoryUserStore } from "../../lib/users";
import { createHttpApp } from "../../mcp/http-app";
import type { ServerOptions } from "../../mcp/server";
import { textResult } from "../../utils/tool-result";
import { InMemorySessionStore } from "../../lib/session";
import {
  InMemoryAccessTokenStore,
  type AccessTokenRecord,
} from "../../lib/oauth";
import {
  registerClient,
  InMemoryClientStore,
  type RegisteredClient,
} from "../../lib/oauth-clients";
import {
  pkceS256Challenge,
  issueAuthorizationCode,
  InMemoryAuthorizationCodeStore,
} from "../../lib/oauth-codes";

const SERVER_URL = new URL("http://localhost:2800/mcp");
const ISSUER_URL = new URL("http://localhost:2800");
const REDIRECT_URI = "https://app.example.com/oauth/callback";
const VERIFIER = "refresh-verifier-".padEnd(64, "r");

class FlakyTokenStore extends InMemoryAccessTokenStore {
  failNextSave = false;

  override async save(tokenHash: string, record: AccessTokenRecord) {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("simulated database failure");
    }
    await super.save(tokenHash, record);
  }
}

type Tokens = { access_token: string; refresh_token?: string };

let server: HttpServer;
let baseUrl: string;
let tokens: FlakyTokenStore;
let clients: InMemoryClientStore;
let codes: InMemoryAuthorizationCodeStore;
let sessions: InMemorySessionStore;
let client: RegisteredClient;
let otherClient: RegisteredClient;
let codeOnlyClient: RegisteredClient;

const sessionProbe = ({ session }: ServerOptions) => {
  const probe = new McpServer({ name: "ChowBot", version: "test" });
  probe.registerTool("whoami", { inputSchema: z.object({}) }, async () =>
    textResult((await session?.get())?.token ?? "no session"),
  );
  return probe;
};

beforeAll(async () => {
  tokens = new FlakyTokenStore();
  clients = new InMemoryClientStore();
  codes = new InMemoryAuthorizationCodeStore();
  sessions = new InMemorySessionStore();
  const app = createHttpApp({
    serverUrl: SERVER_URL,
    issuerUrl: ISSUER_URL,
    users: new InMemoryUserStore(),
    clients,
    codes,
    tokens,
    sessions,
    serverFactory: sessionProbe,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });

  const refreshable = { redirect_uris: [REDIRECT_URI], grant_types: ["authorization_code", "refresh_token"] };
  client = await registerClient(clients, refreshable);
  otherClient = await registerClient(clients, refreshable);
  codeOnlyClient = await registerClient(clients, { redirect_uris: [REDIRECT_URI] });
});

afterAll(() => server.close());

const postToken = (fields: Record<string, string | undefined>) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.append(key, value);
  }
  return fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
};

const signIn = async (userId: string, signInClient = client): Promise<Tokens> => {
  const code = await issueAuthorizationCode(codes, {
    userId,
    clientId: signInClient.client_id,
    redirectUri: REDIRECT_URI,
    codeChallenge: pkceS256Challenge(VERIFIER),
    codeChallengeMethod: "S256",
    resource: SERVER_URL.href,
    scopes: [],
  });
  const response = await postToken({
    grant_type: "authorization_code",
    client_id: signInClient.client_id,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: VERIFIER,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as Tokens;
};

const refresh = (refreshToken: string, overrides: Record<string, string | undefined> = {}) =>
  postToken({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: refreshToken,
    ...overrides,
  });

const json = (response: Response) => response.json() as Promise<Record<string, string>>;

const expectInvalidGrant = async (response: Response, error = "invalid_grant", status = 400) => {
  const body = await json(response);
  expect(response.status).toBe(status);
  expect(body.error).toBe(error);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(body).not.toHaveProperty("access_token");
  expect(body).not.toHaveProperty("refresh_token");
};

const whoami = async (accessToken: string) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
  });
  if (response.status !== 200) return `status ${response.status}`;
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "))!;
  return JSON.parse(data.slice("data: ".length)).result.content[0].text as string;
};

describe("authorization-code exchange", () => {
  test("issues a refresh token only to clients registered for the refresh_token grant", async () => {
    const refreshable = await signIn("user-code-1");
    const codeOnly = await signIn("user-code-2", codeOnlyClient);

    expect(refreshable.refresh_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(refreshable.refresh_token).not.toBe(refreshable.access_token);
    expect(codeOnly).not.toHaveProperty("refresh_token");
  });
});

describe("refresh_token grant", () => {
  test("rotates to a new access token and refresh token bound to the same user", async () => {
    await sessions.set("user-rotate", { token: "chowdeck-token-rotate" });
    const first = await signIn("user-rotate");

    const response = await refresh(first.refresh_token!);
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(body).toEqual({
      access_token: expect.any(String),
      refresh_token: expect.any(String),
      token_type: "Bearer",
      expires_in: 3600 as never,
    });
    expect(body.access_token).not.toBe(first.access_token);
    expect(body.refresh_token).not.toBe(first.refresh_token);
    expect(await whoami(body.access_token!)).toBe("chowdeck-token-rotate");
  });

  test("keeps rotating with each newly issued refresh token", async () => {
    let current = await signIn("user-chain");

    for (let i = 0; i < 3; i += 1) {
      const response = await refresh(current.refresh_token!);
      expect(response.status).toBe(200);
      current = (await response.json()) as Tokens;
    }

    expect(await whoami(current.access_token)).not.toMatch(/^status/);
  });

  test("treats reuse of a rotated token as theft and revokes the whole family", async () => {
    await sessions.set("user-reuse", { token: "chowdeck-token-reuse" });
    const original = await signIn("user-reuse");
    const rotated = (await (await refresh(original.refresh_token!)).json()) as Tokens;
    const warnings = spyOn(console, "error");

    try {
      await expectInvalidGrant(await refresh(original.refresh_token!));

      await expectInvalidGrant(await refresh(rotated.refresh_token!));
      expect(await whoami(rotated.access_token)).toBe("status 401");
      expect(await whoami(original.access_token)).toBe("status 401");
      const logged = warnings.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("Refresh token reuse detected");
      expect(logged).not.toContain(original.refresh_token!);
    } finally {
      warnings.mockRestore();
    }
  });

  test("does not revoke unrelated families when reuse is detected", async () => {
    await sessions.set("user-victim", { token: "chowdeck-token-victim" });
    await sessions.set("user-bystander", { token: "chowdeck-token-bystander" });
    const victim = await signIn("user-victim");
    const victimSecondDevice = await signIn("user-victim");
    const bystander = await signIn("user-bystander");
    const otherClientFamily = await signIn("user-victim", otherClient);
    const warnings = spyOn(console, "error");

    try {
      await refresh(victim.refresh_token!);
      await expectInvalidGrant(await refresh(victim.refresh_token!));
    } finally {
      warnings.mockRestore();
    }

    expect((await refresh(victimSecondDevice.refresh_token!)).status).toBe(200);
    expect((await refresh(bystander.refresh_token!)).status).toBe(200);
    expect(
      (await refresh(otherClientFamily.refresh_token!, { client_id: otherClient.client_id })).status,
    ).toBe(200);
    expect(await whoami(bystander.access_token)).toBe("chowdeck-token-bystander");
  });

  test("lets at most one of several concurrent refreshes with the same token succeed", async () => {
    const tokensForUser = await signIn("user-concurrent");
    const warnings = spyOn(console, "error");

    try {
      const responses = await Promise.all(
        Array.from({ length: 10 }, () => refresh(tokensForUser.refresh_token!)),
      );
      expect(responses.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
      expect(responses.filter((r) => r.status === 400).length).toBeGreaterThanOrEqual(9);
    } finally {
      warnings.mockRestore();
    }
  });

  test.each([
    ["an unknown token", "x".repeat(43)],
    ["a malformed token", "not a refresh token"],
    ["an access token used as a refresh token", undefined],
  ])("rejects %s", async (_, presented) => {
    const issued = await signIn("user-unknown");

    await expectInvalidGrant(await refresh(presented ?? issued.access_token));
  });

  test("rejects a missing refresh_token", async () => {
    await expectInvalidGrant(await refresh(""), "invalid_request");
  });

  test("rejects a token presented by another client without consuming it", async () => {
    const issued = await signIn("user-wrong-client");

    await expectInvalidGrant(await refresh(issued.refresh_token!, { client_id: otherClient.client_id }));

    expect((await refresh(issued.refresh_token!)).status).toBe(200);
  });

  test("rejects clients that are not registered for the refresh_token grant", async () => {
    const issued = await signIn("user-code-only-refresh");

    await expectInvalidGrant(
      await refresh(issued.refresh_token!, { client_id: codeOnlyClient.client_id }),
      "unauthorized_client",
    );
  });

  test.each([
    ["a resource for another server", { resource: "https://other.example/mcp" }, "invalid_target"],
    ["a scope beyond the original grant", { scope: "admin" }, "invalid_scope"],
  ])("rejects %s without consuming the token", async (_, overrides, error) => {
    const issued = await signIn("user-bad-params");

    await expectInvalidGrant(await refresh(issued.refresh_token!, overrides), error);

    expect((await refresh(issued.refresh_token!)).status).toBe(200);
  });

  test("keeps the refresh token usable when storing the new tokens fails", async () => {
    const issued = await signIn("user-flaky");
    tokens.failNextSave = true;
    const errors = spyOn(console, "error");

    try {
      const failed = await refresh(issued.refresh_token!);
      expect(failed.status).toBe(500);
      expect(await failed.text()).not.toContain("simulated database failure");
    } finally {
      errors.mockRestore();
    }

    expect((await refresh(issued.refresh_token!)).status).toBe(200);
  });

  test("never echoes or logs refresh or access tokens", async () => {
    const errors = spyOn(console, "error");
    const issued = await signIn("user-secrets");
    const bodies: string[] = [];

    try {
      bodies.push(await (await refresh(issued.refresh_token!, { client_id: otherClient.client_id })).text());
      const rotated = (await (await refresh(issued.refresh_token!)).json()) as Tokens;
      bodies.push(await (await refresh(issued.refresh_token!)).text());
      tokens.failNextSave = true;
      bodies.push(await (await refresh(rotated.refresh_token!)).text());

      const output = [...bodies, ...errors.mock.calls.flat().map(String)].join("\n");
      for (const secret of [issued.refresh_token!, issued.access_token, rotated.refresh_token!]) {
        expect(output).not.toContain(secret);
      }
    } finally {
      errors.mockRestore();
    }
  });
});
