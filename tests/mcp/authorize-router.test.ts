import type { Server as BunServer } from "bun";
import type { AddressInfo } from "node:net";
import type { Server as HttpServer } from "node:http";
import {
  test,
  spyOn,
  expect,
  describe,
  afterAll,
  beforeAll,
  beforeEach,
} from "bun:test";

import { hashToken } from "../../lib/oauth";
import { ChowdeckClient } from "../../lib/client";
import { InMemoryUserStore } from "../../lib/users";
import { createHttpApp } from "../../mcp/http-app";
import { InMemorySessionStore } from "../../lib/session";
import { InMemoryAccessTokenStore } from "../../lib/oauth";
import type { AuthorizeLimits } from "../../mcp/authorize-router";
import {
  registerClient,
  InMemoryClientStore,
  type RegisteredClient,
} from "../../lib/oauth-clients";
import {
  InMemoryAuthorizationCodeStore,
  type AuthorizationCodeRecord,
} from "../../lib/oauth-codes";

const SERVER_URL = new URL("http://localhost:2800/mcp");
const ISSUER_URL = new URL("http://localhost:2800");
const COOKIE_NAME = "chowbot_authorization";
const REDIRECT_URI = "https://app.example.com/oauth/callback";
const GENEROUS_LIMITS: Partial<AuthorizeLimits> = {
  otpRequestsPerIp: 1000,
  otpRequestsPerPhone: 1000,
  otpVerificationsPerIp: 1000,
};

class RecordingCodeStore extends InMemoryAuthorizationCodeStore {
  readonly saved: AuthorizationCodeRecord[] = [];

  override async save(codeHash: string, record: AuthorizationCodeRecord) {
    this.saved.push(record);
    await super.save(codeHash, record);
  }
}

type Harness = {
  baseUrl: string;
  server: HttpServer;
  users: InMemoryUserStore;
  codes: RecordingCodeStore;
  clients: InMemoryClientStore;
  sessions: InMemorySessionStore;
};

let chowdeck: BunServer<undefined>;
let chowdeckRequests: { path: string; body: Record<string, unknown> }[];
let harness: Harness;
const harnesses: Harness[] = [];

const startHarness = async (limits: Partial<AuthorizeLimits> = GENEROUS_LIMITS) => {
  const users = new InMemoryUserStore();
  const codes = new RecordingCodeStore();
  const clients = new InMemoryClientStore();
  const sessions = new InMemorySessionStore();
  const app = createHttpApp({
    serverUrl: SERVER_URL,
    issuerUrl: ISSUER_URL,
    users,
    codes,
    clients,
    sessions,
    tokens: new InMemoryAccessTokenStore(),
    chowdeck: new ChowdeckClient({ baseUrl: chowdeck.url.origin, timeoutMs: 1000 }),
    authorizeLimits: limits,
  });

  const created = await new Promise<Harness>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}`, server, users, codes, clients, sessions });
    });
  });
  harnesses.push(created);
  return created;
};

beforeAll(async () => {
  chowdeck = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      chowdeckRequests.push({ path, body });

      if (path === "/auth/login") {
        if (body.phone === "08099999999") return Response.json({ message: "Account not found" }, { status: 404 });
        if (body.phone === "08088888888") return Response.json({ message: "boom" }, { status: 500 });
        return Response.json({ status: "success" });
      }
      if (path === "/auth/login/validate-otp") {
        if (body.otp === "333333") return Response.json({ status: "success", data: {} });
        if (body.otp === "111111") {
          return Response.json({ status: "success", data: { token: `chowdeck-token-${body.phone}` } });
        }
        return Response.json({ message: "Invalid OTP" }, { status: 400 });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    },
  });
  harness = await startHarness();
});

afterAll(() => {
  chowdeck.stop(true);
  for (const { server } of harnesses) server.close();
});

beforeEach(() => {
  chowdeckRequests = [];
});

const pkceChallenge = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

const CODE_VERIFIER = "a".repeat(43) + "-verifier-for-tests";
const CODE_CHALLENGE = pkceChallenge(CODE_VERIFIER);

const register = (target: Harness, redirectUris = [REDIRECT_URI], clientName = "Test Client") =>
  registerClient(target.clients, { client_name: clientName, redirect_uris: redirectUris });

const authorizeQuery = (client: RegisteredClient, overrides: Record<string, string | undefined> = {}) => {
  const params = new URLSearchParams();
  const values: Record<string, string | undefined> = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: CODE_CHALLENGE,
    code_challenge_method: "S256",
    state: "state-123",
    resource: SERVER_URL.href,
    ...overrides,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
};

const getAuthorize = (target: Harness, query: string) =>
  fetch(`${target.baseUrl}/authorize?${query}`, { redirect: "manual" });

const cookieFrom = (response: Response) => {
  const header = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${COOKIE_NAME}=([^;]+)`).exec(header);
  return match ? `${COOKIE_NAME}=${match[1]}` : undefined;
};

const csrfFrom = (html: string) => /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];

const postForm = (target: Harness, path: string, fields: Record<string, string>, cookie?: string) =>
  fetch(`${target.baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie && { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
  });

const startSignIn = async (target: Harness, client: RegisteredClient, overrides = {}) => {
  const response = await getAuthorize(target, authorizeQuery(client, overrides));
  const html = await response.text();
  return { response, html, cookie: cookieFrom(response), csrf: csrfFrom(html) };
};

const signInThroughOtp = async (
  target: Harness,
  client: RegisteredClient,
  phone: string,
  overrides = {},
) => {
  const start = await startSignIn(target, client, overrides);
  const phoneResponse = await postForm(
    target,
    "/authorize/phone",
    { csrf_token: start.csrf!, phone },
    start.cookie,
  );
  return { ...start, phoneResponse, phoneHtml: await phoneResponse.text() };
};

describe("authorization request validation", () => {
  test.each([
    ["an unknown client_id", { client_id: "not-registered" }, "Unknown application"],
    ["a missing client_id", { client_id: undefined }, "Unknown application"],
    ["an unregistered redirect_uri", { redirect_uri: "https://evil.example/callback" }, "Invalid redirect"],
    ["a prefix of the redirect_uri", { redirect_uri: `${REDIRECT_URI}/extra` }, "Invalid redirect"],
    ["a missing redirect_uri", { redirect_uri: undefined }, "Invalid redirect"],
    ["response_type=token", { response_type: "token" }, "Unsupported request"],
    ["a missing response_type", { response_type: undefined }, "Unsupported request"],
    ["no PKCE challenge", { code_challenge: undefined }, "PKCE with S256 is required"],
    ["PKCE method plain", { code_challenge_method: "plain" }, "PKCE with S256 is required"],
    ["a missing PKCE method", { code_challenge_method: undefined }, "PKCE with S256 is required"],
    ["a malformed PKCE challenge", { code_challenge: "too-short" }, "PKCE with S256 is required"],
    ["a missing state", { state: undefined }, "Missing or invalid state"],
    ["a state with control characters", { state: "abc\ndef" }, "Missing or invalid state"],
    ["a different resource", { resource: "https://other.example/mcp" }, "Wrong resource for this server"],
  ])("rejects %s without redirecting", async (_, overrides, message) => {
    const client = await register(harness);

    const response = await getAuthorize(harness, authorizeQuery(client, overrides));
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(html).toContain(message);
  });

  test("rejects repeated parameters", async () => {
    const client = await register(harness);

    const response = await getAuthorize(
      harness,
      `${authorizeQuery(client)}&client_id=${client.client_id}`,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });

  test("escapes the client-supplied name on the login page", async () => {
    const client = await register(harness, [REDIRECT_URI], '<script>alert("x")</script>');

    const { html } = await startSignIn(harness, client);

    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
  });
});

describe("login initiation", () => {
  test("shows the phone page with a bound CSRF token and hardened headers", async () => {
    const client = await register(harness);

    const { response, html, cookie, csrf } = await startSignIn(harness, client);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(cookie).toBeDefined();
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' https://app.example.com");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain('action="/authorize/phone"');
    expect(html).toContain("app.example.com");
  });

  test("uses the self-hosted brand font and loads nothing from third parties", async () => {
    const client = await register(harness);

    const { response, html } = await startSignIn(harness, client);
    const csp = response.headers.get("content-security-policy") ?? "";
    const font = await fetch(`${harness.baseUrl}/authorize/assets/plus-jakarta-sans.woff2`);
    const bytes = new Uint8Array(await font.arrayBuffer());

    expect(csp).toContain("font-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(html).toContain('url("/authorize/assets/plus-jakarta-sans.woff2")');
    expect(html).not.toMatch(/https?:\/\/(?!app\.example\.com)/);
    expect(html).toContain("not affiliated with Chowdeck");
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("wOF2");
  });

  test("serves the logo from ChowBot itself", async () => {
    const client = await register(harness);

    const { response, html } = await startSignIn(harness, client);
    const logo = await fetch(`${harness.baseUrl}/authorize/assets/chowbot-logo.svg`);
    const svg = await logo.text();

    expect(response.headers.get("content-security-policy")).toContain("img-src 'self'");
    expect(html).toContain('src="/authorize/assets/chowbot-logo.svg"');
    expect(logo.status).toBe(200);
    expect(logo.headers.get("content-type")).toBe("image/svg+xml");
    expect(svg).toStartWith("<svg");
  });

  test("serves a PNG touch icon from ChowBot itself", async () => {
    const client = await register(harness);

    const { html } = await startSignIn(harness, client);
    const icon = await fetch(`${harness.baseUrl}/authorize/assets/chowbot-icon.png`);
    const bytes = new Uint8Array(await icon.arrayBuffer());

    expect(html).toContain('<link rel="apple-touch-icon" href="/authorize/assets/chowbot-icon.png">');
    expect(icon.status).toBe(200);
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(new TextDecoder().decode(bytes.slice(1, 4))).toBe("PNG");
  });

  test("sends a normalised phone to Chowdeck and shows only a masked number", async () => {
    const client = await register(harness);

    const { phoneResponse, phoneHtml } = await signInThroughOtp(harness, client, "+234 801 234 5678");

    expect(phoneResponse.status).toBe(200);
    expect(chowdeckRequests).toEqual([
      { path: "/auth/login", body: { phone: "08012345678", country_code: "NG", role: "customer" } },
    ]);
    expect(phoneHtml).toContain("0801****678");
    expect(phoneHtml).not.toContain("08012345678");
    expect(phoneHtml).toContain('action="/authorize/verify"');
  });

  test("rejects an invalid phone number without contacting Chowdeck", async () => {
    const client = await register(harness);

    const { phoneResponse, phoneHtml } = await signInThroughOtp(harness, client, "12345");

    expect(phoneResponse.status).toBe(400);
    expect(phoneHtml).toContain("Enter a valid Nigerian mobile number");
    expect(chowdeckRequests).toEqual([]);
  });

  test.each([
    ["a Chowdeck 4xx", "08099999999", 400],
    ["a Chowdeck 5xx", "08088888888", 502],
  ])("handles %s with a generic message", async (_, phone, status) => {
    const client = await register(harness);

    const { phoneResponse, phoneHtml } = await signInThroughOtp(harness, client, phone);

    expect(phoneResponse.status).toBe(status);
    expect(phoneHtml).toContain("Chowdeck could not send a code to that number");
    expect(phoneHtml).not.toContain("Account not found");
    expect(phoneHtml).not.toContain(phone);
  });
});

describe("OTP verification", () => {
  test("issues a code bound to user, client, redirect and challenge, preserving state", async () => {
    const client = await register(harness);
    const state = "opaque state/with+symbols&=?";
    const flow = await signInThroughOtp(harness, client, "08012345678", { state });

    const response = await postForm(
      harness,
      "/authorize/verify",
      { csrf_token: flow.csrf!, otp: "111111" },
      flow.cookie,
    );
    const location = new URL(response.headers.get("location") ?? "");
    const code = location.searchParams.get("code")!;

    expect(response.status).toBe(303);
    expect(`${location.origin}${location.pathname}`).toBe(REDIRECT_URI);
    expect(location.searchParams.get("state")).toBe(state);
    expect([...location.searchParams.keys()].sort()).toEqual(["code", "state"]);
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.href).not.toContain("111111");
    expect(location.href).not.toContain("chowdeck-token");
    expect(response.headers.get("set-cookie")).toContain(`${COOKIE_NAME}=;`);

    const userId = await harness.users.findOrCreateByPhone("08012345678");
    const record = await harness.codes.consume(hashToken(code));
    expect(record).toEqual({
      userId,
      clientId: client.client_id,
      redirectUri: REDIRECT_URI,
      codeChallenge: CODE_CHALLENGE,
      codeChallengeMethod: "S256",
      resource: SERVER_URL.href,
      scopes: [],
      expiresAt: expect.any(Number),
    });
    expect(record!.expiresAt - Date.now() / 1000).toBeLessThanOrEqual(300);
    expect(await harness.sessions.get(userId)).toEqual({
      token: "chowdeck-token-08012345678",
      phone: "08012345678",
    });
  });

  test("keeps the registered redirect URI's own query parameters", async () => {
    const client = await register(harness, ["https://app.example.com/cb?tenant=1"]);
    const flow = await signInThroughOtp(harness, client, "08012345670");

    const response = await postForm(
      harness,
      "/authorize/verify",
      { csrf_token: flow.csrf!, otp: "111111" },
      flow.cookie,
    );
    const location = new URL(response.headers.get("location")!);

    expect(location.searchParams.get("tenant")).toBe("1");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  test("cannot be replayed after a successful sign-in", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345671");
    const submit = () =>
      postForm(harness, "/authorize/verify", { csrf_token: flow.csrf!, otp: "111111" }, flow.cookie);

    expect((await submit()).status).toBe(303);
    const replay = await submit();

    expect(replay.status).toBe(403);
    expect(replay.headers.get("location")).toBeNull();
  });

  test("re-shows the OTP page and issues no code for a wrong code", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345672");
    const savedBefore = harness.codes.saved.length;

    const response = await postForm(
      harness,
      "/authorize/verify",
      { csrf_token: flow.csrf!, otp: "000000" },
      flow.cookie,
    );
    const html = await response.text();

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(html).toContain("That code did not work");
    expect(html).not.toContain("000000");
    expect(harness.codes.saved.length).toBe(savedBefore);
  });

  test("treats a verification response without a token as a failure", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345673");
    const savedBefore = harness.codes.saved.length;

    const response = await postForm(
      harness,
      "/authorize/verify",
      { csrf_token: flow.csrf!, otp: "333333" },
      flow.cookie,
    );

    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(harness.codes.saved.length).toBe(savedBefore);
  });

  test("ends the sign-in after five wrong codes", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345674");
    const attempt = (otp: string) =>
      postForm(harness, "/authorize/verify", { csrf_token: flow.csrf!, otp }, flow.cookie);

    for (let i = 0; i < 5; i += 1) expect((await attempt("000000")).status).toBe(400);
    const blocked = await attempt("111111");

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("location")).toBeNull();
    expect((await attempt("111111")).status).toBe(403);
  });

  test("requires the phone step before verification", async () => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await postForm(
      harness,
      "/authorize/verify",
      { csrf_token: start.csrf!, otp: "111111" },
      start.cookie,
    );

    expect(response.status).toBe(403);
    expect(chowdeckRequests).toEqual([]);
  });
});

describe("CSRF protection", () => {
  test.each([
    ["a missing CSRF token", (csrf: string) => ({ phone: "08012345678" }), true],
    ["a wrong CSRF token", (csrf: string) => ({ csrf_token: `${csrf}x`, phone: "08012345678" }), true],
    ["a missing sign-in cookie", (csrf: string) => ({ csrf_token: csrf, phone: "08012345678" }), false],
  ])("rejects %s", async (_, fields, sendCookie) => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await postForm(
      harness,
      "/authorize/phone",
      fields(start.csrf!),
      sendCookie ? start.cookie : undefined,
    );

    expect(response.status).toBe(403);
    expect(chowdeckRequests).toEqual([]);
  });

  test("rejects a CSRF token from a different sign-in", async () => {
    const client = await register(harness);
    const victim = await startSignIn(harness, client);
    const attacker = await startSignIn(harness, client);

    const response = await postForm(
      harness,
      "/authorize/phone",
      { csrf_token: attacker.csrf!, phone: "08012345678" },
      victim.cookie,
    );

    expect(response.status).toBe(403);
    expect(chowdeckRequests).toEqual([]);
  });
});

describe("rate limiting", () => {
  test("limits OTP requests per phone number", async () => {
    const limited = await startHarness({ ...GENEROUS_LIMITS, otpRequestsPerPhone: 2 });
    const client = await register(limited);

    const statuses = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await signInThroughOtp(limited, client, "08055555555")).phoneResponse.status);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(chowdeckRequests.length).toBe(2);
  });

  test("limits OTP requests per client IP", async () => {
    const limited = await startHarness({ ...GENEROUS_LIMITS, otpRequestsPerIp: 2 });
    const client = await register(limited);

    const statuses = [];
    for (const phone of ["08066666661", "08066666662", "08066666663"]) {
      statuses.push((await signInThroughOtp(limited, client, phone)).phoneResponse.status);
    }

    expect(statuses).toEqual([200, 200, 429]);
    expect(chowdeckRequests.length).toBe(2);
  });

  test("limits OTP verifications per client IP", async () => {
    const limited = await startHarness({ ...GENEROUS_LIMITS, otpVerificationsPerIp: 1 });
    const client = await register(limited);
    const flow = await signInThroughOtp(limited, client, "08077777777");
    const attempt = () =>
      postForm(limited, "/authorize/verify", { csrf_token: flow.csrf!, otp: "000000" }, flow.cookie);

    expect((await attempt()).status).toBe(400);
    const blocked = await attempt();

    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Too many attempts");
  });
});

describe("user isolation", () => {
  const completeSignIn = async (phone: string) => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, phone);
    const response = await postForm(
      harness,
      "/authorize/verify",
      { csrf_token: flow.csrf!, otp: "111111" },
      flow.cookie,
    );
    const code = new URL(response.headers.get("location")!).searchParams.get("code")!;
    return (await harness.codes.consume(hashToken(code)))!;
  };

  test("gives two users separate IDs and sessions", async () => {
    const alice = await completeSignIn("08011111110");
    const bob = await completeSignIn("08022222220");

    expect(alice.userId).not.toBe(bob.userId);
    expect(await harness.sessions.get(alice.userId)).toEqual({
      token: "chowdeck-token-08011111110",
      phone: "08011111110",
    });
    expect(await harness.sessions.get(bob.userId)).toEqual({
      token: "chowdeck-token-08022222220",
      phone: "08022222220",
    });
  });

  test("maps the same verified phone to the same user", async () => {
    const first = await completeSignIn("08033333330");
    const second = await completeSignIn("08033333330");

    expect(second.userId).toBe(first.userId);
  });
});

describe("secret handling", () => {
  test("never logs the phone number, OTP or Chowdeck token", async () => {
    const errors = spyOn(console, "error");
    try {
      const client = await register(harness);
      const failed = await signInThroughOtp(harness, client, "08099999999");
      expect(failed.phoneResponse.status).toBe(400);

      const flow = await signInThroughOtp(harness, client, "08044444440");
      await postForm(harness, "/authorize/verify", { csrf_token: flow.csrf!, otp: "000000" }, flow.cookie);
      await postForm(harness, "/authorize/verify", { csrf_token: flow.csrf!, otp: "111111" }, flow.cookie);

      const logged = errors.mock.calls.flat().map(String).join("\n");
      expect(logged).not.toContain("08099999999");
      expect(logged).not.toContain("08044444440");
      expect(logged).not.toContain("000000");
      expect(logged).not.toContain("111111");
      expect(logged).not.toContain("chowdeck-token");
    } finally {
      errors.mockRestore();
    }
  });
});
