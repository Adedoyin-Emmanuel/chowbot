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
  hashToken,
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
const VERIFIER = "verifier-".padEnd(64, "x");
const CHALLENGE = pkceS256Challenge(VERIFIER);

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

let server: HttpServer;
let baseUrl: string;
let tokens: FlakyTokenStore;
let clients: InMemoryClientStore;
let codes: InMemoryAuthorizationCodeStore;
let sessions: InMemorySessionStore;
let client: RegisteredClient;

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
  client = await registerClient(clients, { client_name: "Test", redirect_uris: [REDIRECT_URI] });
});

afterAll(() => server.close());

const newCode = (overrides: Record<string, unknown> = {}, ttlSeconds?: number) =>
  issueAuthorizationCode(
    codes,
    {
      userId: "user-a",
      clientId: client.client_id,
      redirectUri: REDIRECT_URI,
      codeChallenge: CHALLENGE,
      codeChallengeMethod: "S256",
      resource: SERVER_URL.href,
      scopes: [],
      ...overrides,
    },
    ttlSeconds,
  );

const exchange = (fields: Record<string, string | undefined>, init: RequestInit = {}) => {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) body.append(key, value);
  }
  return fetch(`${baseUrl}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...init.headers },
    body: init.body ?? body.toString(),
  });
};

const validFields = (code: string) => ({
  grant_type: "authorization_code",
  client_id: client.client_id,
  code,
  redirect_uri: REDIRECT_URI,
  code_verifier: VERIFIER,
  resource: SERVER_URL.href,
});

const json = (response: Response) => response.json() as Promise<Record<string, string>>;

const expectError = async (response: Response, status: number, error: string) => {
  const body = await json(response);
  expect(response.status).toBe(status);
  expect(body.error).toBe(error);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(body).not.toHaveProperty("access_token");
  return body;
};

const callWhoami = async (token: string) => {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
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

describe("successful exchange", () => {
  test("returns a bearer token stored only by hash and bound to the code", async () => {
    const code = await newCode();

    const response = await exchange(validFields(code));
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(body).toEqual({ access_token: expect.any(String), token_type: "Bearer", expires_in: 3600 as never });
    expect(body.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    expect(await tokens.get(body.access_token!)).toBeUndefined();
    const record = await tokens.get(hashToken(body.access_token!));
    expect(record).toEqual({
      userId: "user-a",
      clientId: client.client_id,
      scopes: [],
      resource: SERVER_URL.href,
      expiresAt: expect.any(Number),
    });
    expect(record!.expiresAt - Date.now() / 1000).toBeGreaterThan(3590);
  });

  test("accepts a request without the optional resource parameter", async () => {
    const code = await newCode();

    const response = await exchange({ ...validFields(code), resource: undefined });

    expect(response.status).toBe(200);
  });

  test("issues a token that authenticates /mcp and binds the code's user session", async () => {
    await sessions.set("user-b", { token: "chowdeck-token-user-b" });
    const code = await newCode({ userId: "user-b" });

    const { access_token: accessToken } = await json(await exchange(validFields(code)));

    expect(await callWhoami(accessToken!)).toBe("chowdeck-token-user-b");
    expect(await callWhoami("not-a-real-token")).toBe("status 401");
  });

  test("lets exactly one of several concurrent exchanges succeed", async () => {
    const code = await newCode();

    const responses = await Promise.all(Array.from({ length: 10 }, () => exchange(validFields(code))));

    expect(responses.filter((r) => r.status === 200)).toHaveLength(1);
    expect(responses.filter((r) => r.status === 400)).toHaveLength(9);
  });
});

describe("rejected requests", () => {
  test.each([
    ["a missing grant_type", { grant_type: undefined }, 400, "invalid_request"],
    ["grant_type=refresh_token", { grant_type: "refresh_token" }, 400, "unsupported_grant_type"],
    ["grant_type=client_credentials", { grant_type: "client_credentials" }, 400, "unsupported_grant_type"],
    ["a missing client_id", { client_id: undefined }, 400, "invalid_request"],
    ["an unknown client_id", { client_id: "not-registered" }, 401, "invalid_client"],
    ["a client_secret", { client_secret: "s3cret" }, 401, "invalid_client"],
    ["a missing code", { code: undefined }, 400, "invalid_request"],
    ["a missing redirect_uri", { redirect_uri: undefined }, 400, "invalid_request"],
    ["a missing code_verifier", { code_verifier: undefined }, 400, "invalid_request"],
    ["a short code_verifier", { code_verifier: "too-short" }, 400, "invalid_request"],
    ["a code_verifier with invalid characters", { code_verifier: `${"a".repeat(43)}!` }, 400, "invalid_request"],
    ["a resource for another server", { resource: "https://other.example/mcp" }, 400, "invalid_target"],
    ["a malformed resource", { resource: "not a url" }, 400, "invalid_target"],
  ])("rejects %s without consuming the code", async (_, overrides, status, error) => {
    const code = await newCode();

    await expectError(await exchange({ ...validFields(code), ...overrides }), status, error);

    expect((await exchange(validFields(code))).status).toBe(200);
  });

  test.each([
    ["an unknown code", async () => "not-an-issued-code"],
    ["an expired code", () => newCode({}, -1)],
  ])("rejects %s with invalid_grant", async (_, makeCode) => {
    await expectError(await exchange(validFields(await makeCode())), 400, "invalid_grant");
  });

  test("rejects an already redeemed code", async () => {
    const code = await newCode();
    expect((await exchange(validFields(code))).status).toBe(200);

    await expectError(await exchange(validFields(code)), 400, "invalid_grant");
  });

  test.each([
    ["a different redirect_uri", { redirect_uri: "https://app.example.com/oauth/callback/" }],
    ["an incorrect code_verifier", { code_verifier: "wrong-verifier-".padEnd(64, "y") }],
  ])("rejects %s and burns the code", async (_, overrides) => {
    const code = await newCode();

    await expectError(await exchange({ ...validFields(code), ...overrides }), 400, "invalid_grant");

    await expectError(await exchange(validFields(code)), 400, "invalid_grant");
  });

  test("rejects a code issued to another client", async () => {
    const other = await registerClient(clients, { redirect_uris: [REDIRECT_URI] });
    const code = await newCode({ clientId: other.client_id });

    await expectError(await exchange(validFields(code)), 400, "invalid_grant");
  });

  test("rejects a code bound to another resource", async () => {
    const code = await newCode({ resource: "https://other.example/mcp" });

    await expectError(await exchange({ ...validFields(code), resource: undefined }), 400, "invalid_grant");
  });

  test("rejects a client that may not use the authorization_code grant", async () => {
    const restricted = { ...client, client_id: "restricted-client", grant_types: ["client_credentials"] };
    await clients.save(restricted);
    const code = await newCode({ clientId: restricted.client_id });

    await expectError(
      await exchange({ ...validFields(code), client_id: restricted.client_id }),
      400,
      "unauthorized_client",
    );
  });

  test("rejects client authentication through the Authorization header", async () => {
    const code = await newCode();

    await expectError(
      await exchange(validFields(code), { headers: { authorization: "Basic Y2xpZW50OnNlY3JldA==" } }),
      401,
      "invalid_client",
    );
  });

  test("rejects repeated parameters", async () => {
    const code = await newCode();
    const body = `${new URLSearchParams(validFields(code))}&code=${code}`;

    await expectError(await exchange({}, { body }), 400, "invalid_request");
  });

  test.each([
    ["a JSON body", "application/json", (code: string) => JSON.stringify(validFields(code))],
    ["a text body", "text/plain", (code: string) => new URLSearchParams(validFields(code)).toString()],
  ])("rejects %s", async (_, contentType, makeBody) => {
    const code = await newCode();

    await expectError(
      await exchange({}, { headers: { "content-type": contentType }, body: makeBody(code) }),
      400,
      "invalid_request",
    );
  });

  test("rejects an oversized request", async () => {
    const response = await exchange({ grant_type: "authorization_code", padding: "x".repeat(20_000) });

    expect(response.status).toBe(413);
    expect((await json(response)).error).toBe("invalid_request");
  });
});

describe("storage failure", () => {
  test("keeps the code redeemable when storing the token fails", async () => {
    const code = await newCode();
    tokens.failNextSave = true;
    const errors = spyOn(console, "error");

    try {
      const failed = await exchange(validFields(code));
      const body = await expectError(failed, 500, "server_error");
      expect(JSON.stringify(body)).not.toContain("simulated database failure");

      const retried = await exchange(validFields(code));
      expect(retried.status).toBe(200);
    } finally {
      errors.mockRestore();
    }
  });
});

describe("secret handling", () => {
  test("never echoes or logs codes, verifiers or issued tokens", async () => {
    const errors = spyOn(console, "error");
    const code = await newCode();
    const bodies: string[] = [];

    try {
      for (const overrides of [
        { code_verifier: "wrong-verifier-".padEnd(64, "y") },
        { redirect_uri: "https://evil.example/cb" },
        {},
        {},
      ]) {
        const response = await exchange({ ...validFields(code), ...overrides });
        bodies.push(await response.text());
      }

      const issued = await newCode();
      tokens.failNextSave = true;
      bodies.push(await (await exchange(validFields(issued))).text());

      const output = [...bodies, ...errors.mock.calls.flat().map(String)].join("\n");
      expect(output).not.toContain(code);
      expect(output).not.toContain(issued);
      expect(output).not.toContain(VERIFIER);
      expect(output).not.toContain("wrong-verifier-");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("metadata", () => {
  test("advertises only the authorization_code grant and public clients", async () => {
    const metadata = (await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json()) as Record<
      string,
      string[]
    >;

    expect(metadata.grant_types_supported).toEqual(["authorization_code"]);
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(JSON.stringify(metadata)).not.toContain("refresh_token");
  });

  test("answers CORS preflight for browser-based clients", async () => {
    const response = await fetch(`${baseUrl}/token`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });
});
