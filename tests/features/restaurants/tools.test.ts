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
import { registerRestaurantTools } from "../../../features/restaurants/tools";
import {
  InMemorySessionStore,
  bindSession,
  type UserSession,
} from "../../../lib/session";

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
  registerRestaurantTools(
    server,
    session,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const callSearch = (args: Record<string, unknown>, session?: UserSession) =>
  callTool(() => createTestServer(session), "search_restaurants", args);

const sessionWith = async (fields: { token?: string; guestId?: string }) => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save(fields);
  return session;
};

describe("search_restaurants", () => {
  test("is registered on the ChowBot server", async () => {
    const { tools } = await rpc(() => createServer(), "tools/list", {});
    const tool = tools.find((t: { name: string }) => t.name === "search_restaurants");

    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toContain("address_id");
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  test("returns concise restaurant summaries without inventing fields", async () => {
    upstreamResponse = () =>
      Response.json({
        status: "success",
        data: [
          {
            id: 11,
            name: "Mama Put",
            rating: 4.6,
            is_open: true,
            delivery_fee: 50000,
            logo: "https://cdn.example/logo.png",
            menu: [{ id: 1 }],
          },
          { id: 12, name: "Suya Spot" },
          { id: 13, name: "Third" },
        ],
      });

    const result = await callSearch({ address_id: 42, query: "rice", page: 2, limit: 2 });

    expect(result.isError).toBeUndefined();
    expect(receivedUrl?.pathname).toBe("/customer/vendor/v2");
    expect(receivedUrl?.searchParams.get("address_id")).toBe("42");
    expect(receivedUrl?.searchParams.get("q")).toBe("rice");
    expect(receivedUrl?.searchParams.get("page")).toBe("2");

    expect(JSON.parse(result.content[0]!.text)).toEqual({
      address_id: 42,
      page: 2,
      returned: 3,
      truncated: true,
      restaurants: [
        { id: 11, name: "Mama Put", rating: 4.6, is_open: true, delivery_fee: 50000 },
        { id: 12, name: "Suya Spot" },
      ],
    });
  });

  test("rejects a call without address_id before contacting Chowdeck", async () => {
    upstreamResponse = () => Response.json({ data: [] });

    const result = await callSearch({ query: "rice" });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error");
    expect(result.content[0]!.text).toContain("address_id");
    expect(receivedUrl).toBeUndefined();
  });

  test("reports an upstream API failure as a tool error", async () => {
    upstreamResponse = () =>
      Response.json({ status: "fail", message: "Invalid address" }, { status: 422 });

    const result = await callSearch({ address_id: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Failed to search restaurants: GET /customer/vendor/v2 failed with status 422: Invalid address",
    );
  });

  test.each([
    [{ address_id: 0 }, "address_id"],
    [{ address_id: 1.5 }, "address_id"],
    [{ address_id: "42" }, "address_id"],
    [{ address_id: 42, limit: 51 }, "limit"],
    [{ address_id: 42, query: "" }, "query"],
  ])("rejects invalid input %p before contacting Chowdeck", async (args, field) => {
    upstreamResponse = () => Response.json({ data: [] });

    const result = await callSearch(args);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error");
    expect(result.content[0]!.text).toContain(field);
    expect(receivedUrl).toBeUndefined();
  });

  test.each([
    ["data is not an array", { data: { vendors: [] } }],
    ["data is missing", { status: "success" }],
    ["vendors are not objects", { data: ["Mama Put", 42] }],
  ])("reports an unexpected response shape when %s", async (_, body) => {
    upstreamResponse = () => Response.json(body);

    const result = await callSearch({ address_id: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Failed to search restaurants: GET /customer/vendor/v2 returned an unexpected response shape",
    );
  });

  test("returns an empty list only when Chowdeck returns an empty list", async () => {
    upstreamResponse = () => Response.json({ status: "success", data: [] });

    const result = await callSearch({ address_id: 42 });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]!.text)).toEqual({
      address_id: 42,
      returned: 0,
      truncated: false,
      restaurants: [],
    });
  });
});

describe("search_restaurants authentication", () => {
  const vendors = () => Response.json({ data: [{ id: 11, name: "Mama Put" }] });

  test("sends the signed-in user's Chowdeck token", async () => {
    upstreamResponse = vendors;

    const result = await callSearch(
      { address_id: 42 },
      await sessionWith({ token: "secret-token-alice" }),
    );

    expect(result.isError).toBeUndefined();
    expect(receivedAuthorizations).toEqual(["Bearer secret-token-alice"]);
    expect(result.content[0]!.text).not.toContain("secret-token-alice");
  });

  test("searches without authentication when there is no session or no token", async () => {
    upstreamResponse = vendors;

    const anonymous = await callSearch({ address_id: 42 });
    const guest = await callSearch({ address_id: 42 }, await sessionWith({ guestId: "guest-1" }));

    expect(anonymous.isError).toBeUndefined();
    expect(guest.isError).toBeUndefined();
    expect(receivedAuthorizations).toEqual([null, null]);
  });

  test("uses each user's own Chowdeck token", async () => {
    upstreamResponse = vendors;

    await callSearch({ address_id: 42 }, await sessionWith({ token: "secret-token-alice" }));
    await callSearch({ address_id: 42 }, await sessionWith({ token: "secret-token-bob" }));

    expect(receivedAuthorizations).toEqual([
      "Bearer secret-token-alice",
      "Bearer secret-token-bob",
    ]);
  });

  test("reports a rejected token without echoing it", async () => {
    upstreamResponse = () =>
      Response.json({ status: "fail", message: "Unauthenticated" }, { status: 401 });

    const result = await callSearch(
      { address_id: 42 },
      await sessionWith({ token: "secret-token-alice" }),
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe(
      "Failed to search restaurants: GET /customer/vendor/v2 failed with status 401: Unauthenticated",
    );
  });

  test("still validates input and response shape for signed-in users", async () => {
    const session = await sessionWith({ token: "secret-token-alice" });
    upstreamResponse = () => Response.json({ data: ["Mama Put"] });

    const invalid = await callSearch({ address_id: "42" }, session);
    expect(invalid.content[0]!.text).toContain("Input validation error");
    expect(receivedAuthorizations).toEqual([]);

    const malformed = await callSearch({ address_id: 42 }, session);
    expect(malformed.content[0]!.text).toContain("unexpected response shape");
  });
});
