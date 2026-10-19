import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { InMemorySessionStore } from "../../lib/session";
import { InMemoryAccessTokenStore } from "../../lib/oauth";
import { InMemoryClientStore } from "../../lib/oauth-clients";
import { assertIssuerHostedBy, createHttpApp } from "../../mcp/http-app";

const SERVER_URL = new URL("http://localhost:2800/mcp");
const ISSUER_URL = new URL("http://localhost:2800");

let server: HttpServer;
let baseUrl: string;
let clients: InMemoryClientStore;

beforeAll(async () => {
  clients = new InMemoryClientStore();
  const app = createHttpApp({
    serverUrl: SERVER_URL,
    issuerUrl: ISSUER_URL,
    clients,
    tokens: new InMemoryAccessTokenStore(),
    sessions: new InMemorySessionStore(),
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(() => server.close());

const json = (response: Response) => response.json() as Promise<Record<string, unknown>>;

const register = (body: string, contentType = "application/json") =>
  fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });

describe("authorization server metadata", () => {
  test("advertises only the issuer, required endpoints and registration", async () => {
    const response = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(await response.json()).toEqual({
      issuer: "http://localhost:2800",
      authorization_endpoint: "http://localhost:2800/authorize",
      token_endpoint: "http://localhost:2800/token",
      registration_endpoint: "http://localhost:2800/register",
      response_types_supported: ["code"],
    });
  });

  test("names the same issuer as the protected-resource metadata", async () => {
    const authorizationServer = await json(
      await fetch(`${baseUrl}/.well-known/oauth-authorization-server`),
    );
    const protectedResource = await json(
      await fetch(`${baseUrl}/.well-known/oauth-protected-resource/mcp`),
    );

    expect(protectedResource.authorization_servers).toEqual([authorizationServer.issuer]);
    expect(protectedResource.resource).toBe(SERVER_URL.href);
  });

  test.each([
    ["a different origin", "https://auth.example.com", "http://localhost:2800/mcp"],
    ["a different port", "http://localhost:9999", "http://localhost:2800/mcp"],
    ["a path", "http://localhost:2800/oauth", "http://localhost:2800/mcp"],
    ["a query", "http://localhost:2800/?tenant=1", "http://localhost:2800/mcp"],
  ])("refuses an issuer with %s", (_, issuer, serverUrl) => {
    expect(() => assertIssuerHostedBy(new URL(issuer), new URL(serverUrl))).toThrow(
      "OAUTH_ISSUER_URL must be the MCP server origin",
    );
  });
});

describe("POST /register", () => {
  test("registers a client and returns its registered metadata", async () => {
    const response = await register(
      JSON.stringify({
        client_name: "Claude",
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      }),
    );
    const body = await json(response);
    const stored: unknown = await clients.get(String(body.client_id));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(body).toMatchObject({
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(body).not.toHaveProperty("client_secret");
    expect(stored).toEqual(body);
  });

  test("rejects an invalid redirect URI with invalid_redirect_uri", async () => {
    const response = await register(
      JSON.stringify({ redirect_uris: ["https://app.example.com/cb#token"] }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_redirect_uri",
      error_description: "redirect_uris[0] must not contain a fragment",
    });
  });

  test("rejects malformed JSON with invalid_client_metadata", async () => {
    const response = await register("{not json");

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "invalid_client_metadata",
      error_description: "Registration request must be valid JSON",
    });
  });

  test("rejects a non-JSON request body", async () => {
    const response = await register("redirect_uris=https://a.example/cb", "text/plain");

    expect(response.status).toBe(400);
    expect((await json(response)).error).toBe("invalid_client_metadata");
  });

  test("rejects an oversized registration request", async () => {
    const response = await register(
      JSON.stringify({ redirect_uris: ["https://a.example/cb"], client_name: "x".repeat(20_000) }),
    );

    expect(response.status).toBe(413);
    expect((await json(response)).error).toBe("invalid_client_metadata");
  });

  test("answers CORS preflight", async () => {
    const response = await fetch(`${baseUrl}/register`, { method: "OPTIONS" });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });

  test("issues a distinct client for every registration", async () => {
    const body = JSON.stringify({ redirect_uris: ["https://same.example/cb"] });
    const first = await json(await register(body));
    const second = await json(await register(body));

    expect(first.client_id).not.toBe(second.client_id);
  });
});

describe("endpoints not implemented in this milestone", () => {
  test.each(["/authorize", "/token"])("%s is not served yet", async (path) => {
    const response = await fetch(`${baseUrl}${path}`, { method: path === "/token" ? "POST" : "GET" });

    expect(response.status).toBe(404);
  });
});
