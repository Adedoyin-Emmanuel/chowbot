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
import { registerMenuTools } from "../../../features/menus/tools";

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
  registerMenuTools(
    server,
    new ChowdeckClient({ baseUrl: upstream.url.origin, timeoutMs: 1000 }),
  );
  return server;
};

const callGetMenu = (args: Record<string, unknown>) =>
  callTool(createTestServer, "get_restaurant_menu", args);

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
      { id: 201, name: "Chapman", price: 150000, category: { id: 2, name: "Drinks" } },
      { id: 301, name: "Uncategorised Item" },
    ],
  });

describe("get_restaurant_menu", () => {
  test("is registered on the ChowBot server", async () => {
    const { tools } = await rpc(createServer, "tools/list", {});
    const tool = tools.find((t: { name: string }) => t.name === "get_restaurant_menu");

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

    const result = await callGetMenu({ restaurant_id: 11, category: "rice", limit: 1 });

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
  ])("rejects invalid input %p before contacting Chowdeck", async (args, field) => {
    upstreamResponse = menuResponse;

    const result = await callGetMenu(args);

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Input validation error");
    expect(result.content[0]!.text).toContain(field);
    expect(receivedUrl).toBeUndefined();
  });

  test("reports an upstream API failure as a tool error", async () => {
    upstreamResponse = () =>
      Response.json({ status: "fail", message: "Vendor not found" }, { status: 404 });

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
