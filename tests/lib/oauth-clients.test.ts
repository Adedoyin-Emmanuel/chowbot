import { describe, expect, test } from "bun:test";

import {
  registerClient,
  redirectUriProblem,
  InMemoryClientStore,
  ClientRegistrationError,
  isRegisteredRedirectUri,
} from "../../lib/oauth-clients";

const captureRegistrationError = async (body: unknown) => {
  const error = await registerClient(new InMemoryClientStore(), body).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ClientRegistrationError);
  return error as ClientRegistrationError;
};

describe("redirectUriProblem", () => {
  test.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://app.example.com/callback?source=mcp",
    "http://localhost:33418/callback",
    "http://127.0.0.1:8080/cb",
    "http://[::1]:8080/cb",
    "com.example.app:/oauth/callback",
  ])("accepts %s", (uri) => {
    expect(redirectUriProblem(uri)).toBeUndefined();
  });

  test.each([
    ["callback", "must be an absolute URI"],
    ["/relative/path", "must be an absolute URI"],
    ["http://evil.example/callback", "must use https unless it targets a loopback address"],
    ["https://app.example.com/callback#frag", "must not contain a fragment"],
    ["https://*.example.com/callback", "must not contain wildcards"],
    ["https://app.example.com/*", "must not contain wildcards"],
    [" https://app.example.com/callback", "must not contain whitespace"],
    ["https://user:pass@app.example.com/callback", "must not contain credentials"],
    ["javascript:alert(1)", "uses a disallowed scheme"],
    ["data:text/html,hi", "uses a disallowed scheme"],
    ["file:///etc/passwd", "uses a disallowed scheme"],
    ["myapp:/callback", "must use https, loopback http, or a reverse-domain private-use scheme"],
    [`https://app.example.com/${"a".repeat(2000)}`, "is too long"],
  ])("rejects %s", (uri, problem) => {
    expect(redirectUriProblem(uri)).toBe(problem);
  });
});

describe("registerClient", () => {
  test("registers a public authorization-code client with defaults", async () => {
    const store = new InMemoryClientStore();

    const client = await registerClient(store, {
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    });

    expect(client).toEqual({
      client_id: expect.any(String),
      client_id_issued_at: expect.any(Number),
      client_name: "Claude",
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(client).not.toHaveProperty("client_secret");
    expect(await store.get(client.client_id)).toEqual(client);
  });

  test("drops unsupported extras and unknown fields, and de-duplicates URIs", async () => {
    const client = await registerClient(new InMemoryClientStore(), {
      redirect_uris: ["http://localhost:3000/cb", "http://localhost:3000/cb"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      logo_uri: "https://example.com/logo.png",
      scope: "admin",
    });

    expect(client.redirect_uris).toEqual(["http://localhost:3000/cb"]);
    expect(client.grant_types).toEqual(["authorization_code"]);
    expect(client).not.toHaveProperty("logo_uri");
    expect(client).not.toHaveProperty("scope");
  });

  test.each([
    [null, "invalid_client_metadata", "Registration request must be a JSON object"],
    [["https://a.example/cb"], "invalid_client_metadata", "Registration request must be a JSON object"],
    [{}, "invalid_redirect_uri", "redirect_uris must be a non-empty array"],
    [{ redirect_uris: [] }, "invalid_redirect_uri", "redirect_uris must be a non-empty array"],
    [{ redirect_uris: "https://a.example/cb" }, "invalid_redirect_uri", "redirect_uris must be a non-empty array"],
    [{ redirect_uris: [42] }, "invalid_redirect_uri", "redirect_uris[0] must be a string"],
    [
      { redirect_uris: ["https://a.example/cb", "http://evil.example/cb"] },
      "invalid_redirect_uri",
      "redirect_uris[1] must use https unless it targets a loopback address",
    ],
    [
      { redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/cb${i}`) },
      "invalid_redirect_uri",
      "redirect_uris must contain at most 10 entries",
    ],
    [
      { redirect_uris: ["https://a.example/cb"], token_endpoint_auth_method: "client_secret_basic" },
      "invalid_client_metadata",
      'Only public clients are supported (token_endpoint_auth_method "none")',
    ],
    [
      { redirect_uris: ["https://a.example/cb"], grant_types: ["client_credentials"] },
      "invalid_client_metadata",
      'grant_types must include "authorization_code"',
    ],
    [
      { redirect_uris: ["https://a.example/cb"], response_types: ["token"] },
      "invalid_client_metadata",
      'response_types must include "code"',
    ],
    [
      { redirect_uris: ["https://a.example/cb"], client_name: 42 },
      "invalid_client_metadata",
      "client_name: Invalid input: expected string, received number",
    ],
  ])("rejects %p", async (body, code, message) => {
    const error = await captureRegistrationError(body);

    expect(error.code).toBe(code as ClientRegistrationError["code"]);
    expect(error.message).toBe(message);
  });
});

describe("client registration isolation", () => {
  test("gives each client its own identifier and redirect URIs", async () => {
    const store = new InMemoryClientStore();
    const first = await registerClient(store, { redirect_uris: ["https://one.example/cb"] });
    const second = await registerClient(store, { redirect_uris: ["https://two.example/cb"] });

    expect(first.client_id).not.toBe(second.client_id);
    expect((await store.get(first.client_id))?.redirect_uris).toEqual(["https://one.example/cb"]);
    expect((await store.get(second.client_id))?.redirect_uris).toEqual(["https://two.example/cb"]);
    expect(isRegisteredRedirectUri(first, "https://two.example/cb")).toBe(false);
  });

  test("does not let callers mutate a stored registration", async () => {
    const store = new InMemoryClientStore();
    const client = await registerClient(store, { redirect_uris: ["https://one.example/cb"] });

    client.redirect_uris.push("https://attacker.example/cb");
    (await store.get(client.client_id))!.redirect_uris.push("https://attacker.example/cb");

    expect((await store.get(client.client_id))?.redirect_uris).toEqual(["https://one.example/cb"]);
  });
});

describe("isRegisteredRedirectUri", () => {
  const client = {
    client_id: "client-1",
    client_id_issued_at: 0,
    redirect_uris: ["https://app.example.com/callback"],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };

  test("matches the registered URI exactly", () => {
    expect(isRegisteredRedirectUri(client, "https://app.example.com/callback")).toBe(true);
  });

  test.each([
    "https://app.example.com/callback/",
    "https://app.example.com/callback/extra",
    "https://app.example.com/callback?x=1",
    "https://APP.example.com/callback",
    "https://app.example.com:443/callback",
    "https://app.example.com/Callback",
  ])("does not match %s", (uri) => {
    expect(isRegisteredRedirectUri(client, uri)).toBe(false);
  });
});
