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

import {
  bindSession,
  InMemorySessionStore,
  type UserSession,
} from "../../../lib/session";
import { callTool, rpc } from "../../helpers/mcp";
import { createServer } from "../../../mcp/server";
import { ChowdeckClient } from "../../../lib/client";
import { registerMenuTools } from "../../../features/menus/tools";

let upstream: Server<undefined>;
let upstreamResponse: () => Response;
let receivedUrl: URL | undefined;
let receivedAuthorizations: (string | null)[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      receivedUrl = new URL(req.url);
      receivedAuthorizations.push(req.headers.get("authorization"));
      return upstreamResponse();
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  receivedUrl = undefined;
  receivedAuthorizations = [];
});

const createTestServer = (session?: UserSession) => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerMenuTools(
    server,
    session,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const callGetMenu = (args: Record<string, unknown>, session?: UserSession) =>
  callTool(() => createTestServer(session), "get_restaurant_menu", args);

const sessionWith = async (fields: { token?: string; guestId?: string }) => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save(fields);
  return session;
};

const menuResponse = () =>
  Response.json({
    status: "success",
    data: [
      {
        id: 101,
        name: "Jollof Rice",
        description: "Smoky party jollof",
        price: 250000,
        in_stock: true,
        category: { id: 1, name: "Rice Dishes" },
        image: "https://cdn.example/jollof.png",
        add_ons: [{ id: 9, name: "Plantain" }],
      },
      { id: 102, name: "Fried Rice", category: { id: 1, name: "Rice Dishes" } },
      {
        id: 201,
        name: "Chapman",
        price: 150000,
        category: { id: 2, name: "Drinks" },
      },
      { id: 301, name: "Uncategorised Item" },
    ],
  });

describe("get_restaurant_menu", () => {
  test("is registered on the ChowBot server", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const tool = tools.find(
      (t: { name: string }) => t.name === "get_restaurant_menu",
    );

    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["restaurant_id"]);
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  test("returns concise menu items without inventing or converting fields", async () => {
    upstreamResponse = menuResponse;

    const result = await callGetMenu({ restaurant_id: 11 });

    expect(result.isError).toBeUndefined();
    expect(receivedUrl?.pathname).toBe("/customer/vendor/11/menu");
    expect([...(receivedUrl?.searchParams.keys() ?? [])]).toEqual([]);

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      restaurant_id: 11,
      returned: 4,
      truncated: false,
      items: [
        {
          id: 101,
          name: "Jollof Rice",
          description: "Smoky party jollof",
          price: 250000,
          in_stock: true,
          category: "Rice Dishes",
        },
        { id: 102, name: "Fried Rice", category: "Rice Dishes" },
        { id: 201, name: "Chapman", price: 150000, category: "Drinks" },
        { id: 301, name: "Uncategorised Item" },
      ],
    });
  });

  test("filters by category name and applies the limit", async () => {
    upstreamResponse = menuResponse;

    const result = await callGetMenu({
      restaurant_id: 11,
      category: "rice",
      limit: 1,
    });

    expect(JSON.parse(result.content[0]!.text)).toMatchObject({
      category: "rice",
      returned: 2,
      truncated: true,
      items: [{ id: 101 }],
    });
  });

  test.each([
    [{}, "restaurant_id"],
    [{ restaurant_id: 0 }, "restaurant_id"],
    [{ restaurant_id: 1.5 }, "restaurant_id"],
    [{ restaurant_id: "11" }, "restaurant_id"],
    [{ restaurant_id: 11, limit: 101 }, "limit"],
  ])(
    "rejects invalid input %p before contacting Chowdeck",
    async (args, field) => {
      upstreamResponse = menuResponse;

      const result = await callGetMenu(args);

      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("Input validation error");
      expect(result.content[0]!.text).toContain(field);
      expect(receivedUrl).toBeUndefined();
    },
  );

  test("reports an upstream API failure as a tool error", async () => {
    upstreamResponse = () =>
      Response.json(
        { status: "fail", message: "Vendor not found" },
        { status: 404 },
      );

    const result = await callGetMenu({ restaurant_id: 99 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Failed to get restaurant menu: GET /customer/vendor/99/menu failed with status 404: Vendor not found",
    );
  });

  test.each([
    ["data is not an array", { data: { items: [] } }],
    ["data is missing", { status: "success" }],
    ["items are not objects", { data: ["Jollof Rice", 250000] }],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    upstreamResponse = () => Response.json(body);

    const result = await callGetMenu({ restaurant_id: 11 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Failed to get restaurant menu: GET /customer/vendor/11/menu returned an unexpected response shape",
    );
  });

  test("returns an empty menu only when Chowdeck returns an empty list", async () => {
    upstreamResponse = () => Response.json({ data: [] });

    const result = await callGetMenu({ restaurant_id: 11 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      restaurant_id: 11,
      returned: 0,
      truncated: false,
      items: [],
    });
  });
});

describe("get_restaurant_menu authentication", () => {
  test("sends the signed-in user's Chowdeck token", async () => {
    upstreamResponse = menuResponse;

    const result = await callGetMenu(
      { restaurant_id: 11 },
      await sessionWith({ token: "secret-token-alice" }),
    );

    expect(result.isError).toBeUndefined();
    expect(receivedAuthorizations).toEqual(["Bearer secret-token-alice"]);
    expect(result.content[0]!.text).not.toContain("secret-token-alice");
  });

  test("fetches without authentication when there is no session or no token", async () => {
    upstreamResponse = menuResponse;

    const anonymous = await callGetMenu({ restaurant_id: 11 });
    const guest = await callGetMenu(
      { restaurant_id: 11 },
      await sessionWith({ guestId: "guest-1" }),
    );

    expect(anonymous.isError).toBeUndefined();
    expect(guest.isError).toBeUndefined();
    expect(receivedAuthorizations).toEqual([null, null]);
  });

  test("uses each user's own Chowdeck token", async () => {
    upstreamResponse = menuResponse;

    await callGetMenu(
      { restaurant_id: 11 },
      await sessionWith({ token: "secret-token-alice" }),
    );
    await callGetMenu(
      { restaurant_id: 11 },
      await sessionWith({ token: "secret-token-bob" }),
    );

    expect(receivedAuthorizations).toEqual([
      "Bearer secret-token-alice",
      "Bearer secret-token-bob",
    ]);
  });

  test("reports a rejected token without echoing it", async () => {
    upstreamResponse = () =>
      Response.json(
        { status: "fail", message: "Unauthenticated" },
        { status: 401 },
      );

    const result = await callGetMenu(
      { restaurant_id: 11 },
      await sessionWith({ token: "secret-token-alice" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Failed to get restaurant menu: GET /customer/vendor/11/menu failed with status 401: Unauthenticated",
    );
  });

  test("still validates input and response shape for signed-in users", async () => {
    const session = await sessionWith({ token: "secret-token-alice" });
    upstreamResponse = () => Response.json({ data: ["Jollof Rice"] });

    const invalid = await callGetMenu({ restaurant_id: "11" }, session);
    expect(invalid.content[0]!.text).toContain("Input validation error");
    expect(receivedAuthorizations).toEqual([]);

    const malformed = await callGetMenu({ restaurant_id: 11 }, session);
    expect(malformed.content[0]!.text).toContain("unexpected response shape");
  });
});
