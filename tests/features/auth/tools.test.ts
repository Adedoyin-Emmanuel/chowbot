import {
  test,
  expect,
  describe,
  afterAll,
  beforeAll,
  beforeEach,
} from "bun:test";
import type { Server } from "bun";
import { McpServer } from "@modelcontextprotocol/server";

import { callTool, rpc } from "../../helpers/mcp";
import { createServer } from "../../../mcp/server";
import { ChowdeckClient } from "../../../lib/client";
import { registerAuthTools } from "../../../features/auth/tools";
import {
  InMemorySessionStore,
  bindSession,
  type UserSession,
} from "../../../lib/session";

type ReceivedRequest = {
  path: string;
  body: Record<string, unknown>;
};

const TOKENS_BY_OTP: Record<string, string> = {
  "111111": "secret-token-alice",
  "222222": "secret-token-bob",
};

let upstream: Server<undefined>;
let received: ReceivedRequest[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = (await req.json()) as Record<string, unknown>;
      received.push({ path, body });

      if (path === "/auth/login") {
        return body.phone === "08099999999"
          ? Response.json({ message: "Account not found" }, { status: 404 })
          : Response.json({ status: "success", message: "OTP sent" });
      }

      if (path === "/auth/login/validate-otp") {
        const otp = String(body.otp);
        if (otp === "333333") return Response.json({ status: "success", data: {} });
        const token = TOKENS_BY_OTP[otp];
        return token
          ? Response.json({ status: "success", data: { token } })
          : Response.json({ status: "fail", message: "Invalid OTP" }, { status: 400 });
      }

      return Response.json({ message: "unexpected path" }, { status: 500 });
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  received = [];
});

const serverFor = (session?: UserSession) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerAuthTools(
    server,
    session,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;

describe("auth tools", () => {
  test("are registered when chat login is enabled (stdio)", async () => {
    const { tools } = await rpc(() => createServer({ enableChatLogin: true }), "tools/list", {});
    const names = tools.map((tool: { name: string }) => tool.name);

    expect(names).toContain("request_login_otp");
    expect(names).toContain("verify_login_otp");
  });

  test("are not registered by default (remote HTTP)", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const names = tools.map((tool: { name: string }) => tool.name);

    expect(names).not.toContain("request_login_otp");
    expect(names).not.toContain("verify_login_otp");
  });

  test("request_login_otp sends a normalised phone and masks it in the result", async () => {
    const session = bindSession(new InMemorySessionStore(), "alice");

    const result = await callTool(serverFor(session), "request_login_otp", {
      phone: "+2348012345678",
    });

    expect(result.isError).toBeUndefined();
    expect(received).toEqual([
      {
        path: "/auth/login",
        body: { phone: "08012345678", country_code: "NG", role: "customer" },
      },
    ]);
    expect(textOf(result)).toContain("0801****678");
    expect(textOf(result)).not.toContain("08012345678");
    expect(await session.get()).toBeUndefined();
  });

  test("verify_login_otp stores the token in the session without returning it", async () => {
    const session = bindSession(new InMemorySessionStore(), "alice");

    const result = await callTool(serverFor(session), "verify_login_otp", {
      phone: "08012345678",
      otp: "111111",
    });

    expect(result.isError).toBeUndefined();
    expect(received[0]).toEqual({
      path: "/auth/login/validate-otp",
      body: { otp: "111111", phone: "08012345678", country_code: "NG", role: "customer" },
    });
    expect(textOf(result)).toBe("Logged in to Chowdeck as 0801****678.");
    expect(textOf(result)).not.toContain("secret-token");
    expect(await session.get()).toEqual({
      token: "secret-token-alice",
      phone: "08012345678",
    });
  });

  test("keeps two users' Chowdeck sessions isolated", async () => {
    const store = new InMemorySessionStore();
    const alice = bindSession(store, "alice");
    const bob = bindSession(store, "bob");

    await callTool(serverFor(alice), "verify_login_otp", {
      phone: "08011111111",
      otp: "111111",
    });

    expect(await bob.get()).toBeUndefined();

    await callTool(serverFor(bob), "verify_login_otp", {
      phone: "08022222222",
      otp: "222222",
    });

    expect(await alice.get()).toEqual({ token: "secret-token-alice", phone: "08011111111" });
    expect(await bob.get()).toEqual({ token: "secret-token-bob", phone: "08022222222" });
  });

  test("preserves existing session fields such as the guest ID", async () => {
    const session = bindSession(new InMemorySessionStore(), "alice");
    await session.save({ guestId: "guest-1" });

    await callTool(serverFor(session), "verify_login_otp", {
      phone: "08012345678",
      otp: "111111",
    });

    expect(await session.get()).toEqual({
      guestId: "guest-1",
      token: "secret-token-alice",
      phone: "08012345678",
    });
  });

  test.each([
    ["request_login_otp", {}],
    ["request_login_otp", { phone: "12345" }],
    ["request_login_otp", { phone: "+14155550123" }],
    ["verify_login_otp", { phone: "08012345678" }],
    ["verify_login_otp", { phone: "08012345678", otp: "12ab" }],
    ["verify_login_otp", { phone: "not-a-phone", otp: "111111" }],
  ])("%s rejects invalid input %p before contacting Chowdeck", async (tool, args) => {
    const session = bindSession(new InMemorySessionStore(), "alice");

    const result = await callTool(serverFor(session), tool, args);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
    expect(received).toEqual([]);
  });

  test("reports an upstream login failure without storing anything", async () => {
    const session = bindSession(new InMemorySessionStore(), "alice");

    const result = await callTool(serverFor(session), "request_login_otp", {
      phone: "08099999999",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to send login code: POST /auth/login failed with status 404: Account not found",
    );
    expect(await session.get()).toBeUndefined();
  });

  test("reports a rejected OTP without echoing the code or storing a session", async () => {
    const session = bindSession(new InMemorySessionStore(), "alice");

    const result = await callTool(serverFor(session), "verify_login_otp", {
      phone: "08012345678",
      otp: "000000",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to verify login code: POST /auth/login/validate-otp failed with status 400: Invalid OTP",
    );
    expect(textOf(result)).not.toContain("000000");
    expect(await session.get()).toBeUndefined();
  });

  test("treats a verification response without a token as a failure", async () => {
    const session = bindSession(new InMemorySessionStore(), "alice");

    const result = await callTool(serverFor(session), "verify_login_otp", {
      phone: "08012345678",
      otp: "333333",
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("did not return a session token");
    expect(await session.get()).toBeUndefined();
  });

  test.each(["request_login_otp", "verify_login_otp"])(
    "%s refuses without a bound session and never contacts Chowdeck",
    async (tool) => {
      const result = await callTool(serverFor(undefined), tool, {
        phone: "08012345678",
        otp: "111111",
      });

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Login is not available on this connection");
      expect(received).toEqual([]);
    },
  );
});
