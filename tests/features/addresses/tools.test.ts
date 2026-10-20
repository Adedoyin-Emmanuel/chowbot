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
  type UserSession,
  InMemorySessionStore,
} from "../../../lib/session";
import { callTool, rpc } from "../../helpers/mcp";
import { createServer } from "../../../mcp/server";
import { ChowdeckClient } from "../../../lib/client";
import { registerAddressTools } from "../../../features/addresses/tools";
import { registerRestaurantTools } from "../../../features/restaurants/tools";

type ReceivedRequest = {
  path: string;
  method: string;
  headers: Headers;
};

let upstream: Server<undefined>;
let upstreamResponse: (req: Request) => Response;
let received: ReceivedRequest[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      received.push({
        method: req.method,
        path: new URL(req.url).pathname,
        headers: req.headers,
      });
      return upstreamResponse(req);
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  received = [];
});

const signedInSession = async (token = "secret-token-alice") => {
  const session = bindSession(new InMemorySessionStore(), crypto.randomUUID());
  await session.save({ token, phone: "08012345678" });
  return session;
};

const serverFor = (session?: UserSession) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerAddressTools(
    server,
    session,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const listAddresses = (session?: UserSession) =>
  callTool(serverFor(session), "list_addresses", {});

const textOf = (result: { content: { text: string }[] }) =>
  result.content[0]!.text;

describe("list_addresses", () => {
  test("is registered on the ChowBot server for both transports", async () => {
    for (const enableChatLogin of [false, true]) {
      const { tools } = await rpc(
        () => createServer({ enableChatLogin }),
        "tools/list",
        {},
      );
      const tool = tools.find(
        (t: { name: string }) => t.name === "list_addresses",
      );

      expect(tool).toBeDefined();
      expect(tool.annotations.readOnlyHint).toBe(true);
    }
  });

  test("sends the session token and returns concise address summaries", async () => {
    upstreamResponse = () =>
      Response.json({
        status: "success",
        data: [
          {
            id: 42,
            pretty_name: "12 Admiralty Way, Lekki",
            house_no: "12",
            street: "Admiralty Way",
            area: "Lekki Phase 1",
            city: "Lagos",
            state: "Lagos",
            country: "Nigeria",
            is_current: true,
            latitude: 6.4474,
            longitude: 3.4723,
            place_id: "ChIJ-example",
            user: { id: 7, phone: "08012345678" },
          },
          { id: 43, pretty_name: "Office" },
        ],
      });

    const result = await listAddresses(await signedInSession());

    expect(result.isError).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("GET");
    expect(received[0]!.path).toBe("/customer/address");
    expect(received[0]!.headers.get("authorization")).toBe(
      "Bearer secret-token-alice",
    );
    expect(received[0]!.headers.get("x-app-name")).toBe("storefront");

    expect(textOf(result)).not.toContain("secret-token-alice");
    expect(JSON.parse(textOf(result))).toEqual({
      returned: 2,
      addresses: [
        {
          id: 42,
          pretty_name: "12 Admiralty Way, Lekki",
          house_no: "12",
          street: "Admiralty Way",
          area: "Lekki Phase 1",
          city: "Lagos",
          state: "Lagos",
          country: "Nigeria",
          is_current: true,
        },
        { id: 43, pretty_name: "Office" },
      ],
    });
  });

  test("uses each user's own Chowdeck session", async () => {
    upstreamResponse = () => Response.json({ data: [] });

    await listAddresses(await signedInSession("secret-token-alice"));
    await listAddresses(await signedInSession("secret-token-bob"));

    expect(received.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer secret-token-alice",
      "Bearer secret-token-bob",
    ]);
  });

  test("returns an empty list when the account has no saved addresses", async () => {
    upstreamResponse = () => Response.json({ status: "success", data: [] });

    const result = await listAddresses(await signedInSession());

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ returned: 0, addresses: [] });
  });

  test("skips entries without a usable address id", async () => {
    upstreamResponse = () =>
      Response.json({
        data: [
          { pretty_name: "No id" },
          { id: "44", city: "Abuja" },
          "junk",
          { id: 45, city: "Ibadan" },
        ],
      });

    const result = await listAddresses(await signedInSession());

    expect(JSON.parse(textOf(result))).toEqual({
      returned: 1,
      addresses: [{ id: 45, city: "Ibadan" }],
    });
  });

  test("asks the user to sign in without contacting Chowdeck when there is no token", async () => {
    upstreamResponse = () => Response.json({ data: [] });
    const session = bindSession(
      new InMemorySessionStore(),
      crypto.randomUUID(),
    );
    await session.save({ guestId: "guest-1" });

    const result = await listAddresses(session);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to list addresses: not signed in to Chowdeck. Sign in, then try again.",
    );
    expect(received).toHaveLength(0);
  });

  test("refuses to run without a per-user session", async () => {
    upstreamResponse = () => Response.json({ data: [] });

    const result = await listAddresses();

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });

  test("reports a rejected Chowdeck session without echoing the token", async () => {
    upstreamResponse = () =>
      Response.json(
        { status: "fail", message: "Unauthenticated" },
        { status: 401 },
      );

    const result = await listAddresses(await signedInSession());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to list addresses: GET /customer/address failed with status 401: Unauthenticated",
    );
    expect(textOf(result)).not.toContain("secret-token-alice");
  });

  test("reports an upstream server error as a tool error", async () => {
    upstreamResponse = () =>
      new Response("Bad gateway", { status: 502, statusText: "Bad Gateway" });

    const result = await listAddresses(await signedInSession());

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to list addresses: GET /customer/address failed with status 502: Bad Gateway",
    );
  });

  test("reports an unexpected response shape instead of returning an empty list", async () => {
    for (const body of [
      { data: { addresses: [] } },
      { data: [{ pretty_name: "No id" }] },
      [],
    ]) {
      upstreamResponse = () => Response.json(body);

      const result = await listAddresses(await signedInSession());

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(
        "Failed to list addresses: GET /customer/address returned an unexpected response shape",
      );
    }
  });

  test("returns ids that search_restaurants accepts and forwards unchanged", async () => {
    let searchUrl: URL | undefined;
    upstreamResponse = (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/customer/address") {
        return Response.json({ data: [{ id: 42, pretty_name: "Home" }] });
      }
      searchUrl = url;
      return Response.json({ data: [] });
    };

    const session = await signedInSession();
    const createDiscoveryServer = () => {
      const server = new McpServer({ name: "ChowBot", version: "test" });
      const client = new ChowdeckClient({
        baseUrl: upstream.url.origin,
        timeoutMs: 1000,
      });
      registerAddressTools(server, session, client);
      registerRestaurantTools(server, session, client);
      return server;
    };

    const listed = await callTool(createDiscoveryServer, "list_addresses", {});
    const [address] = JSON.parse(textOf(listed)).addresses;
    const searched = await callTool(
      createDiscoveryServer,
      "search_restaurants",
      {
        address_id: address.id,
      },
    );

    expect(searched.isError).toBeUndefined();
    expect(searchUrl?.pathname).toBe("/customer/vendor/v2");
    expect(searchUrl?.searchParams.get("address_id")).toBe("42");
  });
});
