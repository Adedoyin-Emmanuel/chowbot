import type { Server as BunServer } from "bun";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
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
import type { AuthorizeUi } from "../../mcp/authorize-ui";
import {
  csrfFrom,
  testAuthorizeUi,
  authorizeStateFrom,
  postAuthorizeJson,
} from "../helpers/authorize";
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

const startHarness = async (
  limits: Partial<AuthorizeLimits> = GENEROUS_LIMITS,
  ui: AuthorizeUi | null = testAuthorizeUi(),
) => {
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
    ...(ui && { authorizeUi: ui }),
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

const postJson = (
  target: Harness,
  path: string,
  body: Record<string, unknown> | undefined,
  cookie?: string,
  csrf?: string,
) => postAuthorizeJson(`${target.baseUrl}${path}`, body, { cookie, csrf });

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
  const phoneResponse = await postJson(target, "/authorize/phone", { phone }, start.cookie, start.csrf);
  return { ...start, phoneResponse, phoneBody: await phoneResponse.text() };
};

const verify = (target: Harness, flow: { cookie?: string; csrf?: string }, otp: string) =>
  postJson(target, "/authorize/verify", { otp }, flow.cookie, flow.csrf);

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { message: string; title?: string; restart?: boolean } }).error;

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
    const state = authorizeStateFrom(await response.text());

    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(state).toEqual({ view: "error", title: expect.any(String), message: expect.any(String) });
    expect(state?.view === "error" && `${state.title}: ${state.message}`).toContain(message);
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

  test("embeds a hostile client name without letting it break out of the state", async () => {
    const name = '</script><script>alert("x")</script><!--';
    const client = await register(harness, [REDIRECT_URI], name);

    const { html } = await startSignIn(harness, client);

    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<!--");
    expect(authorizeStateFrom(html)).toMatchObject({ view: "phone", clientName: name });
  });
});

describe("login initiation", () => {
  test("serves the sign-in app on the phone step with a bound CSRF token and hardened headers", async () => {
    const client = await register(harness);

    const { response, html, cookie, csrf } = await startSignIn(harness, client);
    const setCookie = response.headers.get("set-cookie") ?? "";
    const csp = response.headers.get("content-security-policy") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(cookie).toBeDefined();
    expect(csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(authorizeStateFrom(html)).toEqual({ view: "phone", csrfToken: csrf!, clientName: "Test Client" });
    expect(html).toContain('<div id="root"></div>');
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  test("never puts the OAuth parameters in the page", async () => {
    const client = await register(harness);

    const { html } = await startSignIn(harness, client, { state: "secret-state-value" });

    expect(html).not.toContain("secret-state-value");
    expect(html).not.toContain(CODE_CHALLENGE);
    expect(html).not.toContain(REDIRECT_URI);
  });

  test("sends a normalised phone to Chowdeck and returns only a masked number", async () => {
    const client = await register(harness);

    const { phoneResponse, phoneBody } = await signInThroughOtp(harness, client, "+234 801 234 5678");

    expect(phoneResponse.status).toBe(200);
    expect(phoneResponse.headers.get("cache-control")).toBe("no-store");
    expect(chowdeckRequests).toEqual([
      { path: "/auth/login", body: { phone: "08012345678", country_code: "NG", role: "customer" } },
    ]);
    expect(JSON.parse(phoneBody)).toEqual({ maskedPhone: "0801****678" });
  });

  test("rejects an invalid phone number without contacting Chowdeck", async () => {
    const client = await register(harness);

    const { phoneResponse, phoneBody } = await signInThroughOtp(harness, client, "12345");

    expect(phoneResponse.status).toBe(400);
    expect(JSON.parse(phoneBody).error.message).toContain("Enter a valid Nigerian mobile number");
    expect(chowdeckRequests).toEqual([]);
  });

  test.each([
    ["a Chowdeck 4xx", "08099999999", 400],
    ["a Chowdeck 5xx", "08088888888", 502],
  ])("handles %s with a generic message", async (_, phone, status) => {
    const client = await register(harness);

    const { phoneResponse, phoneBody } = await signInThroughOtp(harness, client, phone);

    expect(phoneResponse.status).toBe(status);
    expect(phoneBody).toContain("Chowdeck could not send a code to that number");
    expect(phoneBody).not.toContain("Account not found");
    expect(phoneBody).not.toContain(phone);
  });
});

describe("refreshing the code step", () => {
  test("resumes the same sign-in on the code step", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345600");

    const response = await fetch(`${harness.baseUrl}/authorize/verify`, { headers: { cookie: flow.cookie! } });
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(authorizeStateFrom(html)).toEqual({
      view: "otp",
      csrfToken: flow.csrf!,
      clientName: "Test Client",
      maskedPhone: "0801****600",
    });
    expect(html).not.toContain("08012345600");
  });

  test("returns to the phone step when no code was requested yet", async () => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await fetch(`${harness.baseUrl}/authorize/verify`, { headers: { cookie: start.cookie! } });

    expect(authorizeStateFrom(await response.text())).toMatchObject({ view: "phone" });
  });

  test("shows an expired page without a sign-in cookie", async () => {
    const response = await fetch(`${harness.baseUrl}/authorize/verify`);

    expect(response.status).toBe(403);
    expect(authorizeStateFrom(await response.text())).toEqual({
      view: "error",
      title: "Sign-in expired",
      message: "Start again from your assistant.",
    });
  });
});

describe("resending the code", () => {
  test("sends a new code to the number from the phone step", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345601");

    const response = await postJson(harness, "/authorize/resend", undefined, flow.cookie, flow.csrf);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ maskedPhone: "0801****601" });
    expect(chowdeckRequests.map(({ body }) => body.phone)).toEqual(["08012345601", "08012345601"]);
  });

  test("needs the phone step first", async () => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await postJson(harness, "/authorize/resend", undefined, start.cookie, start.csrf);

    expect(response.status).toBe(403);
    expect((await errorOf(response)).restart).toBe(true);
    expect(chowdeckRequests).toEqual([]);
  });

  test("counts against the per-phone limit", async () => {
    const limited = await startHarness({ ...GENEROUS_LIMITS, otpRequestsPerPhone: 2 });
    const client = await register(limited);
    const flow = await signInThroughOtp(limited, client, "08012345602");
    const resend = () => postJson(limited, "/authorize/resend", undefined, flow.cookie, flow.csrf);

    expect((await resend()).status).toBe(200);
    expect((await resend()).status).toBe(429);
    expect(chowdeckRequests.length).toBe(2);
  });
});

describe("OTP verification", () => {
  test("issues a code bound to user, client, redirect and challenge, preserving state", async () => {
    const client = await register(harness);
    const state = "opaque state/with+symbols&=?";
    const flow = await signInThroughOtp(harness, client, "08012345678", { state });

    const response = await verify(harness, flow, "111111");
    const { redirectUrl } = (await response.json()) as { redirectUrl: string };
    const location = new URL(redirectUrl);
    const code = location.searchParams.get("code")!;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
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

    const response = await verify(harness, flow, "111111");
    const location = new URL(((await response.json()) as { redirectUrl: string }).redirectUrl);

    expect(location.searchParams.get("tenant")).toBe("1");
    expect(location.searchParams.get("code")).toBeTruthy();
  });

  test("cannot be replayed after a successful sign-in", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345671");

    expect((await verify(harness, flow, "111111")).status).toBe(200);
    const replay = await verify(harness, flow, "111111");

    expect(replay.status).toBe(403);
    expect(await errorOf(replay)).toEqual({
      title: "Sign-in expired",
      message: "Start again from your assistant.",
      restart: true,
    });
  });

  test("lets the user retry and issues no code for a wrong code", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345672");
    const savedBefore = harness.codes.saved.length;

    const response = await verify(harness, flow, "000000");
    const body = await response.text();

    expect(response.status).toBe(400);
    expect(JSON.parse(body).error).toEqual({ message: "That code did not work. Check it and try again." });
    expect(body).not.toContain("000000");
    expect(harness.codes.saved.length).toBe(savedBefore);
  });

  test("rejects a non-numeric code without contacting Chowdeck", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345675");
    chowdeckRequests = [];

    const response = await verify(harness, flow, "12ab");

    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain("numeric code");
    expect(chowdeckRequests).toEqual([]);
  });

  test("treats a verification response without a token as a failure", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345673");
    const savedBefore = harness.codes.saved.length;

    const response = await verify(harness, flow, "333333");

    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("redirectUrl");
    expect(harness.codes.saved.length).toBe(savedBefore);
  });

  test("ends the sign-in after five wrong codes", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345674");

    for (let i = 0; i < 5; i += 1) expect((await verify(harness, flow, "000000")).status).toBe(400);
    const blocked = await verify(harness, flow, "111111");

    expect(blocked.status).toBe(429);
    expect((await errorOf(blocked)).restart).toBe(true);
    expect((await verify(harness, flow, "111111")).status).toBe(403);
  });

  test("requires the phone step before verification", async () => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await verify(harness, start, "111111");

    expect(response.status).toBe(403);
    expect(chowdeckRequests).toEqual([]);
  });

  test("rejects a malformed body and ends the sign-in on the app", async () => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, "08012345676");

    const response = await fetch(`${harness.baseUrl}/authorize/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: flow.cookie!, "x-csrf-token": flow.csrf! },
      body: "{not json",
    });

    expect(response.status).toBe(400);
    expect((await errorOf(response)).restart).toBe(true);
  });
});

describe("CSRF protection", () => {
  test.each([
    ["a missing CSRF header", (csrf: string) => undefined, true],
    ["a wrong CSRF header", (csrf: string) => `${csrf}x`, true],
    ["a missing sign-in cookie", (csrf: string) => csrf, false],
  ])("rejects %s", async (_, header, sendCookie) => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await postJson(
      harness,
      "/authorize/phone",
      { phone: "08012345678" },
      sendCookie ? start.cookie : undefined,
      header(start.csrf!),
    );

    expect(response.status).toBe(403);
    expect(chowdeckRequests).toEqual([]);
  });

  test("ignores a CSRF token sent in the body instead of the header", async () => {
    const client = await register(harness);
    const start = await startSignIn(harness, client);

    const response = await postJson(
      harness,
      "/authorize/phone",
      { phone: "08012345678", csrf_token: start.csrf },
      start.cookie,
    );

    expect(response.status).toBe(403);
    expect(chowdeckRequests).toEqual([]);
  });

  test("rejects a CSRF token from a different sign-in", async () => {
    const client = await register(harness);
    const victim = await startSignIn(harness, client);
    const attacker = await startSignIn(harness, client);

    const response = await postJson(
      harness,
      "/authorize/phone",
      { phone: "08012345678" },
      victim.cookie,
      attacker.csrf,
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

    expect((await verify(limited, flow, "000000")).status).toBe(400);
    const blocked = await verify(limited, flow, "000000");

    expect(blocked.status).toBe(429);
    expect(await errorOf(blocked)).toEqual({
      title: "Too many attempts",
      message: "Wait a few minutes and try again.",
    });
  });
});

describe("sign-in app files", () => {
  let dir: string;
  let withAssets: Harness;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "chowbot-auth-ui-"));
    await mkdir(join(dir, "assets"));
    await Bun.write(join(dir, "assets", "main-abc123.js"), "console.log('app')");
    await Bun.write(join(dir, ".secret"), "nope");
    withAssets = await startHarness(GENEROUS_LIMITS, testAuthorizeUi(join(dir, "assets")));
  });

  afterAll(() => rm(dir, { recursive: true, force: true }));

  test("serves hashed assets with long-lived caching", async () => {
    const response = await fetch(`${withAssets.baseUrl}/authorize/assets/main-abc123.js`);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("javascript");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("console.log('app')");
  });

  test.each([
    ["a missing asset", "/authorize/assets/missing.js"],
    ["a path outside the assets folder", "/authorize/assets/..%2f.secret"],
  ])("answers 404 for %s", async (_, path) => {
    const response = await fetch(`${withAssets.baseUrl}${path}`);

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("nope");
  });

  test("says sign-in is unavailable when the app has not been built", async () => {
    const unbuilt = await startHarness(GENEROUS_LIMITS, null);
    const client = await register(unbuilt);

    const response = await getAuthorize(unbuilt, authorizeQuery(client));
    const html = await response.text();

    expect(response.status).toBe(503);
    expect(html).toContain("sign-in is unavailable");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
  });
});

describe("user isolation", () => {
  const completeSignIn = async (phone: string) => {
    const client = await register(harness);
    const flow = await signInThroughOtp(harness, client, phone);
    const response = await verify(harness, flow, "111111");
    const { redirectUrl } = (await response.json()) as { redirectUrl: string };
    const code = new URL(redirectUrl).searchParams.get("code")!;
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
      await verify(harness, flow, "000000");
      await verify(harness, flow, "111111");

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
