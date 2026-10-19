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

let upstream: Server<undefined>;
let upstreamResponse: () => Response;
let receivedUrl: URL | undefined;

beforeAll(() => {
  upstream = Bun.serve({
    port: 0,
    fetch(req) {
      receivedUrl = new URL(req.url);
      return upstreamResponse();
    },
  });
});

afterAll(() => upstream.stop(true));

beforeEach(() => {
  receivedUrl = undefined;
});

const createTestServer = () => {
  const server = new McpServer({ name: "ChowBot", version: "test" });
  registerRestaurantTools(
    server,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const callSearch = (args: Record<string, unknown>) =>
  callTool(createTestServer, "search_restaurants", args);

describe("search_restaurants", () => {
  test("is registered on the ChowBot server", async () => {
    const { tools } = await rpc(createServer, "tools/list", {});
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

  test("reports an unexpected response shape instead of returning an empty list", async () => {
    upstreamResponse = () => Response.json({ data: { vendors: [] } });

    const result = await callSearch({ address_id: 42 });

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unexpected response shape");
  });
});
