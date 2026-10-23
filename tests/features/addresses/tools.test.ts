import {
  test,
  expect,
  describe,
  afterAll,
  beforeAll,
  beforeEach,
  spyOn,
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
  search: string;
  query: URLSearchParams;
  body: unknown;
};

let upstream: Server<undefined>;
let upstreamResponse: (req: Request) => Response | Promise<Response>;
let received: ReceivedRequest[];

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const text = await req.text();
      received.push({
        method: req.method,
        path: url.pathname,
        headers: req.headers,
        search: url.search,
        query: url.searchParams,
        body: text ? JSON.parse(text) : undefined,
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

  test("returns ids that browse_restaurants accepts and forwards unchanged", async () => {
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
      "browse_restaurants",
      {
        address_id: address.id,
      },
    );

    expect(searched.isError).toBeUndefined();
    expect(searchUrl?.pathname).toBe("/customer/vendor/v2");
    expect(searchUrl?.searchParams.get("address_id")).toBe("42");
  });
});

/*
 * search_address_places and add_address, with every Chowdeck call mocked
 * and fictional places only.
 */

type Route = (req: Request) => Response | Promise<Response>;
const PLACE_ID = "ChIJ_FICTIONAL_PLACE_ID";
const NEW_ADDRESS_ID = 77001;

const routeAll = (routes: Record<string, Route>) => {
  upstreamResponse = (req) => {
    const route = routes[`${req.method} ${new URL(req.url).pathname}`];
    return route ? route(req) : Response.json({ message: "unexpected request" }, { status: 500 });
  };
};

const placeDetails = (result: Record<string, unknown> = {}) => () =>
  Response.json({
    html_attributions: [],
    status: "OK",
    result: {
      place_id: PLACE_ID,
      name: "Example Crescent",
      formatted_address: "12 Example Crescent, Sampleville, Lagos, Nigeria",
      geometry: { location: { lat: 6.4321, lng: 3.4567 } },
      types: ["street_address"],
      vicinity: "Sampleville",
      address_components: [
        { long_name: "12", short_name: "12", types: ["street_number"] },
        { long_name: "Sampleville", short_name: "SV", types: ["neighborhood", "political"] },
        { long_name: "Lagos City", short_name: "LC", types: ["locality", "political"] },
        { long_name: "Lagos", short_name: "LA", types: ["administrative_area_level_1", "political"] },
        { long_name: "Nigeria", short_name: "NG", types: ["country", "political"] },
      ],
      ...result,
    },
  });

const created = (data: Record<string, unknown> = {}) => () =>
  Response.json({
    status: "success",
    message: "Address successfully created",
    data: {
      id: NEW_ADDRESS_ID,
      street: "Example Crescent",
      pretty_name: "12 Example Crescent, Sampleville, Lagos, Nigeria",
      city: "Sampleville",
      state: "Lagos",
      country: "Nigeria",
      coordinate: { latitude: 6.4321, longitude: 3.4567 },
      house_number: null,
      floor: null,
      direction: null,
      tag: null,
      extra_information: null,
      created_at: "2026-10-21T16:36:53.000Z",
      updated_at: "2026-10-21T16:36:53.000Z",
      last_used: "2026-10-21T16:36:53.000Z",
      is_active: false,
      is_current: false,
      ...data,
    },
  });

const listed = (ids: number[]) => () =>
  Response.json({ status: "success", data: ids.map((id) => ({ id, pretty_name: `Address ${id}` })) });

const activated = () =>
  Response.json({ status: "success", message: "Address set as current active address successfully" });

const happyRoutes = (overrides: Record<string, Route> = {}) =>
  routeAll({
    "GET /place/details/json": placeDetails(),
    "POST /customer/address": created(),
    "GET /customer/address": listed([42, NEW_ADDRESS_ID]),
    "POST /customer/address/set-active": activated,
    ...overrides,
  });

const serverWith = (session?: UserSession, timeoutMs = 1000) => () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerAddressTools(server, session, new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs }));
  return server;
};

const calls = (method: string, path: string) => received.filter((r) => r.method === method && r.path === path);

describe("address tools registration", () => {
  test("search_address_places is read-only and add_address is a non-idempotent write, on both transports", async () => {
    for (const enableChatLogin of [false, true]) {
      const { tools } = await rpc(() => createServer({ enableChatLogin }), "tools/list", {});
      const byName = (name: string) => tools.find((t: { name: string }) => t.name === name);

      expect(byName("search_address_places").annotations.readOnlyHint).toBe(true);
      expect(byName("add_address").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
      expect(Object.keys(byName("add_address").inputSchema.properties).sort()).toEqual(["activate", "confirm_duplicate", "place_id"]);
    }
  });
});

describe("search_address_places", () => {
  const search = async (query: unknown, session?: UserSession, timeoutMs?: number) =>
    callTool(serverWith(session ?? (await signedInSession()), timeoutMs), "search_address_places", { query });

  test("sends the trimmed, encoded search text with the user's token and returns bounded suggestions", async () => {
    upstreamResponse = () =>
      Response.json({
        status: "OK",
        predictions: Array.from({ length: 12 }, (_, i) => ({
          description: `${i} Example Crescent, Sampleville, Lagos, Nigeria`,
          place_id: `ChIJ_FICTIONAL_${i}`,
          reference: "REF-SHOULD-NOT-LEAK",
          matched_substrings: [],
          structured_formatting: { main_text: `${i} Example Crescent`, secondary_text: "Sampleville" },
          terms: [],
          types: ["street_address"],
        })),
      });

    const result = await search("  12 Example & Co / Sampleville  ");

    expect(result.isError).toBeUndefined();
    expect(received).toHaveLength(1);
    expect(received[0]!.method).toBe("GET");
    expect(received[0]!.path).toBe("/place/autocomplete/json");
    expect(received[0]!.query.get("input")).toBe("12 Example & Co / Sampleville");
    expect([...received[0]!.query.keys()]).toEqual(["input"]);
    expect(received[0]!.search).toContain("%26");
    expect(received[0]!.headers.get("authorization")).toBe("Bearer secret-token-alice");

    const parsed = JSON.parse(textOf(result));
    expect(parsed.returned).toBe(10);
    expect(parsed.suggestions[0]).toEqual({
      place_id: "ChIJ_FICTIONAL_0",
      description: "0 Example Crescent, Sampleville, Lagos, Nigeria",
      main_text: "0 Example Crescent",
      secondary_text: "Sampleville",
    });
    expect(textOf(result)).not.toContain("REF-SHOULD-NOT-LEAK");
    expect(textOf(result)).not.toContain("secret-token-alice");
  });

  test("returns an empty list when nothing matches", async () => {
    upstreamResponse = () => Response.json({ status: "ZERO_RESULTS", predictions: [] });

    const result = await search("Nowhere Close");

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toEqual({ returned: 0, suggestions: [] });
  });

  test.each([["ab"], ["  ab  "], [""]])("refuses %p (fewer than three characters) without contacting Chowdeck", async (query) => {
    upstreamResponse = () => Response.json({ status: "OK", predictions: [] });

    const result = await search(query);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
    expect(received).toHaveLength(0);
  });

  test.each([
    ["a malformed body", () => Response.json({ status: "OK", predictions: "nope" }), "Failed to search for places: GET /place/autocomplete/json returned an unexpected response shape"],
    ["a non-OK status", () => Response.json({ status: "REQUEST_DENIED", predictions: [] }), "Failed to search for places: GET /place/autocomplete/json returned status REQUEST_DENIED"],
    ["an upstream error", () => Response.json({ message: "Server Error" }, { status: 502 }), "Failed to search for places: GET /place/autocomplete/json failed with status 502: Server Error"],
  ])("reports %s as a tool error", async (_, reply, message) => {
    upstreamResponse = reply;

    const result = await search("Example Crescent");

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(message);
  });

  test("reports a timeout", async () => {
    upstreamResponse = async () => {
      await Bun.sleep(300);
      return Response.json({ status: "OK", predictions: [] });
    };

    const result = await search("Example Crescent", undefined, 100);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Failed to search for places: GET /place/autocomplete/json timed out after 100ms");
  });

  test("uses each user's own session, and asks a signed-out user to sign in without contacting Chowdeck", async () => {
    upstreamResponse = () => Response.json({ status: "ZERO_RESULTS", predictions: [] });

    await search("Example Crescent", await signedInSession("secret-token-alice"));
    await search("Example Crescent", await signedInSession("secret-token-bob"));
    expect(received.map((r) => r.headers.get("authorization"))).toEqual(["Bearer secret-token-alice", "Bearer secret-token-bob"]);

    received = [];
    const guest = bindSession(new InMemorySessionStore(), crypto.randomUUID());
    await guest.save({ guestId: "guest-1" });
    const result = await search("Example Crescent", guest);
    expect(textOf(result)).toBe("Failed to search for places: not signed in to Chowdeck. Sign in, then try again.");
    expect(received).toHaveLength(0);
  });

  test("refuses to run without a per-user session", async () => {
    const result = await callTool(serverWith(undefined), "search_address_places", { query: "Example Crescent" });

    expect(textOf(result)).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });
});

describe("add_address", () => {
  const add = async (args: Record<string, unknown>, session?: UserSession, timeoutMs?: number) =>
    callTool(serverWith(session ?? (await signedInSession()), timeoutMs), "add_address", args);

  const EXPECTED_BODY = {
    place_id: PLACE_ID,
    house_no: "12",
    street: "Example Crescent",
    pretty_name: "12 Example Crescent, Sampleville, Lagos, Nigeria",
    longitude: 3.4567,
    latitude: 6.4321,
    city: "Sampleville",
    state: "Lagos",
    country: "Nigeria",
    area: "Sampleville",
  };

  test("resolves the place, creates the address with the ten fields once, verifies it, and never activates it by default", async () => {
    happyRoutes();

    const result = await add({ place_id: PLACE_ID });

    expect(result.isError).toBeUndefined();
    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /place/details/json",
      "GET /customer/address",
      "POST /customer/address",
      "GET /customer/address",
    ]);
    expect(received[0]!.query.get("placeid")).toBe(PLACE_ID);
    expect([...received[0]!.query.keys()]).toEqual(["placeid"]);
    for (const request of received) expect(request.headers.get("authorization")).toBe("Bearer secret-token-alice");
    expect(calls("POST", "/customer/address")[0]!.body).toEqual(EXPECTED_BODY);

    const parsed = JSON.parse(textOf(result));
    expect(parsed).toEqual({
      status: "created",
      address_id: NEW_ADDRESS_ID,
      address: {
        pretty_name: "12 Example Crescent, Sampleville, Lagos, Nigeria",
        street: "Example Crescent",
        city: "Sampleville",
        state: "Lagos",
        country: "Nigeria",
        is_active: false,
        is_current: false,
      },
      activation: { status: "not_requested" },
      verification: { status: "verified" },
    });
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
    expect(textOf(result)).not.toContain("secret-token-alice");
  });

  test("activate: false never calls set-active", async () => {
    happyRoutes();

    await add({ place_id: PLACE_ID, activate: false });

    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("activate: true sends {addressId} after creating, then verifies", async () => {
    happyRoutes();

    const result = await add({ place_id: PLACE_ID, activate: true });

    expect(received.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /place/details/json",
      "GET /customer/address",
      "POST /customer/address",
      "POST /customer/address/set-active",
      "GET /customer/address",
    ]);
    expect(calls("POST", "/customer/address/set-active")[0]!.body).toEqual({ addressId: NEW_ADDRESS_ID });
    expect(JSON.parse(textOf(result)).activation).toEqual({ status: "activated" });
  });

  test("never uses caller-supplied coordinates or address text", async () => {
    happyRoutes();

    await add({ place_id: PLACE_ID, latitude: 1, longitude: 2, street: "Injected Street", pretty_name: "Injected" });

    expect(calls("POST", "/customer/address")[0]!.body).toEqual(EXPECTED_BODY);
  });

  test.each([
    ["is refused", () => Response.json({ status: "failed", message: "Address not found" }, { status: 404 }), "failed", "failed with status 404: Address not found"],
    ["fails upstream", () => Response.json({ message: "Server Error" }, { status: 500 }), "unknown", "may or may not be active now"],
    ["returns an unexpected envelope", () => Response.json({ status: "pending" }), "unknown", "returned an unexpected response"],
  ])("reports the address as created when activation %s", async (_, reply, status, detail) => {
    happyRoutes({ "POST /customer/address/set-active": reply });

    const result = await add({ place_id: PLACE_ID, activate: true });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.address_id).toBe(NEW_ADDRESS_ID);
    expect(parsed.activation.status).toBe(status);
    expect(parsed.activation.detail).toContain(detail);
    expect(parsed.verification).toEqual({ status: "verified" });
    expect(calls("POST", "/customer/address")).toHaveLength(1);
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(1);
  });

  test.each([
    ["a success without data", () => Response.json({ status: "success", message: "Address successfully created" })],
    ["a non-numeric id", created({ id: "77001" })],
    ["a zero id", created({ id: 0 })],
    ["a fractional id", created({ id: 1.5 })],
    ["a non-success envelope", () => Response.json({ status: "failed", data: { id: NEW_ADDRESS_ID } })],
    ["a non-JSON body", () => new Response("<html>ok</html>", { status: 200 })],
    ["a server error", () => Response.json({ message: "Server Error" }, { status: 503 })],
    ["an expired token", () => Response.json({ message: "Unauthenticated" }, { status: 401 })],
  ])("treats %s as an unknown outcome, sends nothing more, and points to list_addresses", async (_, reply) => {
    happyRoutes({ "POST /customer/address": reply });

    const result = await add({ place_id: PLACE_ID, activate: true });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("the address may or may not have been created. Check list_addresses before trying again");
    expect(calls("POST", "/customer/address")).toHaveLength(1);
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("never retries a create that timed out", async () => {
    happyRoutes({
      "POST /customer/address": async () => {
        await Bun.sleep(300);
        return created()();
      },
    });

    const result = await add({ place_id: PLACE_ID }, undefined, 100);
    await Bun.sleep(400);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Failed to add the address: POST /customer/address timed out after 100ms; the address may or may not have been created. Check list_addresses before trying again",
    );
    expect(calls("POST", "/customer/address")).toHaveLength(1);
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("reports a definite rejection as nothing created", async () => {
    happyRoutes({ "POST /customer/address": () => Response.json({ status: "failed", message: "Invalid address" }, { status: 422 }) });

    const result = await add({ place_id: PLACE_ID });

    expect(textOf(result)).toBe("Failed to add the address: POST /customer/address failed with status 422: Invalid address; no address was created");
    expect(calls("POST", "/customer/address")).toHaveLength(1);
  });

  test.each([
    ["malformed details", () => Response.json({ status: "OK", result: [] }), "returned an unexpected response shape"],
    ["a non-OK details status", () => Response.json({ status: "NOT_FOUND" }), "returned status NOT_FOUND"],
    ["missing coordinates", placeDetails({ geometry: {} }), "returned a place without valid coordinates"],
    ["string coordinates", placeDetails({ geometry: { location: { lat: "6.4", lng: "3.4" } } }), "returned a place without valid coordinates"],
    ["no formatted address", placeDetails({ formatted_address: undefined }), "returned a place without a formatted address"],
    ["a details timeout", async () => { await Bun.sleep(300); return placeDetails()(); }, "timed out after 100ms"],
    ["a details server error", () => Response.json({ message: "Server Error" }, { status: 500 }), "failed with status 500: Server Error"],
  ])("creates nothing when the place lookup gives %s", async (_, reply, detail) => {
    happyRoutes({ "GET /place/details/json": reply });

    const result = await add({ place_id: PLACE_ID, activate: true }, undefined, 100);

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain(detail);
    expect(textOf(result)).toEndWith("; no address was created");
    expect(calls("POST", "/customer/address")).toHaveLength(0);
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test.each([
    ["the new id is not listed", listed([42]), "not_listed", `address ${NEW_ADDRESS_ID} is not in the saved-address list yet`],
    ["the list fails", () => Response.json({ message: "Server Error" }, { status: 500 }), "unavailable", "could not be re-read"],
    ["the list is malformed", () => Response.json({ data: "nope" }), "unavailable", "could not be re-read"],
  ])("does not claim verification when %s", async (_, reply, status, detail) => {
    // The first read is the duplicate check; only the refresh after creating fails.
    let reads = 0;
    happyRoutes({ "GET /customer/address": () => (reads++ === 0 ? listed([42])() : reply()) });

    const result = await add({ place_id: PLACE_ID });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result));
    expect(parsed.address_id).toBe(NEW_ADDRESS_ID);
    expect(parsed.verification.status).toBe(status);
    expect(parsed.verification.detail).toContain(detail);
  });

  test("uses each user's own session for every call, and needs one", async () => {
    happyRoutes();

    await add({ place_id: PLACE_ID }, await signedInSession("secret-token-bob"));
    expect(new Set(received.map((r) => r.headers.get("authorization")))).toEqual(new Set(["Bearer secret-token-bob"]));

    received = [];
    const guest = bindSession(new InMemorySessionStore(), crypto.randomUUID());
    await guest.save({ guestId: "guest-1" });
    const result = await add({ place_id: PLACE_ID }, guest);
    expect(textOf(result)).toBe("Failed to add the address: not signed in to Chowdeck. Sign in, then try again.");
    expect(received).toHaveLength(0);

    const noSession = await callTool(serverWith(undefined), "add_address", { place_id: PLACE_ID });
    expect(textOf(noSession)).toContain("cannot identify individual users");
    expect(received).toHaveLength(0);
  });

  test.each([[""], ["has spaces"], ["x".repeat(513)]])("rejects the place_id %p before contacting Chowdeck", async (placeId) => {
    happyRoutes();

    const result = await add({ place_id: placeId });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("Input validation error");
    expect(received).toHaveLength(0);
  });

  test("logs no place ids, address text or tokens on failure paths", async () => {
    const logged: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    try {
      happyRoutes({ "POST /customer/address": () => Response.json({ message: "Server Error" }, { status: 503 }) });
      await add({ place_id: PLACE_ID });
      happyRoutes({ "GET /place/details/json": () => Response.json({ status: "OK", result: [] }) });
      await add({ place_id: PLACE_ID });
    } finally {
      spy.mockRestore();
    }

    const text = logged.join("\n");
    for (const secret of [PLACE_ID, "Example Crescent", "secret-token-alice", "6.4321"]) expect(text).not.toContain(secret);
  });
});

describe("add_address duplicate handling", () => {
  const add = async (args: Record<string, unknown>, session?: UserSession) =>
    callTool(serverWith(session ?? (await signedInSession())), "add_address", args);

  const savedHome = { id: 42, pretty_name: "12 Example Crescent, Sampleville, Lagos, Nigeria", street: "Example Crescent", city: "Sampleville", state: "Lagos" };
  const withSaved = (saved: Record<string, unknown>[], overrides: Record<string, Route> = {}) =>
    happyRoutes({ "GET /customer/address": () => Response.json({ status: "success", data: saved }), ...overrides });

  test("creates nothing and returns the plausible matches with a confirmation value", async () => {
    withSaved([savedHome, { id: 43, pretty_name: "Office", street: "Other Road", city: "Elsewhere" }]);

    const result = await add({ place_id: PLACE_ID, activate: true });

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(textOf(result));
    expect(parsed).toMatchObject({
      status: "possible_duplicate",
      created: false,
      place: { pretty_name: "12 Example Crescent, Sampleville, Lagos, Nigeria", street: "Example Crescent", city: "Sampleville" },
      matches: [{ address_id: 42, reasons: ["same formatted address", "same street and city"] }],
    });
    expect(parsed.matches).toHaveLength(1);
    expect(parsed.confirm_duplicate).toMatch(/^dup_[A-Za-z0-9_-]{22}$/);
    expect(parsed.guidance).toContain("Nothing was created");
    expect(calls("POST", "/customer/address")).toHaveLength(0);
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("creates the address once when the user confirms with the returned value", async () => {
    withSaved([savedHome]);
    const first = JSON.parse(textOf(await add({ place_id: PLACE_ID })));
    received = [];

    const result = await add({ place_id: PLACE_ID, confirm_duplicate: first.confirm_duplicate });

    expect(result.isError).toBeUndefined();
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "created", address_id: NEW_ADDRESS_ID, activation: { status: "not_requested" } });
    expect(calls("POST", "/customer/address")).toHaveLength(1);
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("refuses a confirmation issued for a different place", async () => {
    withSaved([savedHome]);
    const first = JSON.parse(textOf(await add({ place_id: PLACE_ID })));
    withSaved([savedHome], {
      "GET /place/details/json": placeDetails({ place_id: "ChIJ_FICTIONAL_OTHER", geometry: { location: { lat: 6.43215, lng: 3.45675 } } }),
    });
    received = [];

    const result = JSON.parse(textOf(await add({ place_id: "ChIJ_FICTIONAL_OTHER", confirm_duplicate: first.confirm_duplicate })));

    expect(result.status).toBe("possible_duplicate");
    expect(result.confirm_duplicate).not.toBe(first.confirm_duplicate);
    expect(result.guidance).toContain("does not match this place");
    expect(calls("POST", "/customer/address")).toHaveLength(0);
  });

  test("refuses a confirmation once the matching saved addresses change", async () => {
    withSaved([savedHome]);
    const first = JSON.parse(textOf(await add({ place_id: PLACE_ID })));
    withSaved([savedHome, { ...savedHome, id: 44 }]);
    received = [];

    const result = JSON.parse(textOf(await add({ place_id: PLACE_ID, confirm_duplicate: first.confirm_duplicate })));

    expect(result.status).toBe("possible_duplicate");
    expect(result.matches.map((m: { address_id: number }) => m.address_id)).toEqual([42, 44]);
    expect(calls("POST", "/customer/address")).toHaveLength(0);
  });

  test("a confirmation from one account does not authorize a duplicate on another", async () => {
    withSaved([savedHome]);
    const alices = JSON.parse(textOf(await add({ place_id: PLACE_ID }, await signedInSession("secret-token-alice"))));
    withSaved([{ ...savedHome, id: 9001 }]);
    received = [];

    const result = JSON.parse(textOf(await add({ place_id: PLACE_ID, confirm_duplicate: alices.confirm_duplicate }, await signedInSession("secret-token-bob"))));

    expect(result.status).toBe("possible_duplicate");
    expect(calls("POST", "/customer/address")).toHaveLength(0);
  });

  test("creates normally when nothing matches, ignoring any confirmation value", async () => {
    withSaved([{ id: 43, pretty_name: "Office", street: "Example Crescent", city: "Otherville" }]);

    const result = JSON.parse(textOf(await add({ place_id: PLACE_ID, confirm_duplicate: "dup_AAAAAAAAAAAAAAAAAAAAAA" })));

    expect(result.status).toBe("created");
    expect(calls("POST", "/customer/address")).toHaveLength(1);
  });

  test.each([
    ["fails", () => Response.json({ message: "Server Error" }, { status: 500 }), "GET /customer/address failed with status 500: Server Error"],
    ["is malformed", () => Response.json({ data: "nope" }), "GET /customer/address returned an unexpected response shape"],
  ])("creates nothing when the duplicate check %s, even with a confirmation value", async (_, reply, detail) => {
    happyRoutes({ "GET /customer/address": reply });

    for (const args of [{ place_id: PLACE_ID }, { place_id: PLACE_ID, confirm_duplicate: "dup_AAAAAAAAAAAAAAAAAAAAAA" }]) {
      const result = await add(args);

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(`Failed to add the address: could not check your saved addresses for duplicates (${detail}); no address was created`);
    }
    expect(calls("POST", "/customer/address")).toHaveLength(0);
  });

  test.each([["dup_short"], ["not-a-token"], ["dup_" + "A".repeat(23)]])("rejects the malformed confirmation %p before contacting Chowdeck", async (token) => {
    happyRoutes();

    const result = await add({ place_id: PLACE_ID, confirm_duplicate: token });

    expect(textOf(result)).toContain("Input validation error");
    expect(received).toHaveLength(0);
  });
});

/*
 * The website's address switcher (from the user's capture): POST
 * /customer/address/set-active {addressId}, then the list shows is_current.
 */
describe("set_active_address", () => {
  const HOME = 1870516;
  const WORK = 3976486;
  const addresses = (current: number) => () =>
    Response.json({
      status: "success",
      data: [HOME, WORK].map((id) => ({ id, pretty_name: `Address ${id}`, is_active: true, is_current: id === current, coordinate: { x: 3.28, y: 6.68 } })),
    });
  const switchTo = async (address_id: number, timeoutMs?: number) =>
    callTool(serverWith(await signedInSession(), timeoutMs), "set_active_address", { address_id });

  test("switches with the website's payload and confirms it from the re-read list", async () => {
    let current = HOME;
    routeAll({
      "GET /customer/address": () => addresses(current)(),
      "POST /customer/address/set-active": () => {
        current = (received.at(-1)!.body as { addressId: number }).addressId;
        return Response.json({ status: "success", message: "Address set as current active address successfully" });
      },
    });

    const result = await switchTo(WORK);
    const parsed = JSON.parse(textOf(result));

    expect(result.isError).toBeUndefined();
    expect(calls("POST", "/customer/address/set-active").map((r) => r.body)).toEqual([{ addressId: WORK }]);
    expect(parsed).toMatchObject({ address_id: WORK, status: "activated", address: { id: WORK, is_current: true } });
    expect(textOf(result)).not.toContain("coordinate");
  });

  test("sends nothing when the address is already active", async () => {
    routeAll({ "GET /customer/address": addresses(WORK) });

    const parsed = JSON.parse(textOf(await switchTo(WORK)));

    expect(parsed.status).toBe("already_active");
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("refuses an address that is not saved on the account, sending nothing", async () => {
    routeAll({ "GET /customer/address": addresses(HOME) });

    const result = await switchTo(999);

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result)).status).toBe("not_saved");
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(0);
  });

  test("does not claim the switch when the re-read list still shows another address current", async () => {
    routeAll({
      "GET /customer/address": addresses(HOME),
      "POST /customer/address/set-active": () => Response.json({ status: "success", message: "Address set as current active address successfully" }),
    });

    const result = await switchTo(WORK);

    expect(result.isError).toBe(true);
    expect(JSON.parse(textOf(result))).toMatchObject({ status: "unconfirmed" });
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(1);
  });

  test("reports Chowdeck's refusal without retrying", async () => {
    routeAll({
      "GET /customer/address": addresses(HOME),
      "POST /customer/address/set-active": () => Response.json({ status: "failed", message: "Address not found" }, { status: 404 }),
    });

    const parsed = JSON.parse(textOf(await switchTo(WORK)));

    expect(parsed.status).toBe("rejected");
    expect(parsed.message).toContain("Address not found");
    expect(calls("POST", "/customer/address/set-active")).toHaveLength(1);
  });
});
