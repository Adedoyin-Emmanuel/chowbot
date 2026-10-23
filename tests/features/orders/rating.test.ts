import { describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/server";

import { callTool } from "../../helpers/mcp";
import { ChowdeckClient } from "../../../lib/client";
import { registerOrderTools } from "../../../features/orders/tools";
import { ORDER_ID, mock, orderRecord, parse, route, sent, signedIn, slow, useMockChowdeck } from "../../helpers/ordering";

useMockChowdeck();

const ORDER_PATH = `/customer/order/${ORDER_ID}`;
const RATE_PATH = `${ORDER_PATH}/rate-or-review`;

// A delivered, paid order with the two shawarmas from the user's capture.
const delivered = orderRecord({
  status: "success",
  payment: { status: "success" },
  items: [
    { item_id: 1110005, name: "Chicken shawarma", type: "menu", quantity: 1 },
    { item_id: 1110006, name: "Beef shawarma", type: "menu", quantity: 1 },
  ],
});

const rated = () => Response.json({ status: "success", message: "successfully added rating/review" });

const rate = async (args: Record<string, unknown>, timeoutMs = 1000) => {
  const session = await signedIn();
  return callTool(
    () => {
      const server = new McpServer({ name: "ChowBot", version: "test" });
      registerOrderTools(server, session, new ChowdeckClient({ baseUrl: mock.url, timeoutMs }));
      return server;
    },
    "rate_order",
    { order_id: ORDER_ID, ...args },
  );
};

describe("rate_order", () => {
  test("sends the website's rating payload once and reports Chowdeck's answer", async () => {
    route(`GET ${ORDER_PATH}`, delivered);
    route(`POST ${RATE_PATH}`, rated);

    const result = await rate({
      rating: 5,
      reasons: ["Worth it"],
      review: "Nice one.",
      items: [
        { item_id: 1110005, liked: true },
        { item_id: 1110006, liked: true },
      ],
    });
    const report = parse(result);

    expect(result.isError).toBeUndefined();
    expect(sent("POST", RATE_PATH).map((r) => r.body)).toEqual([
      {
        vendor_rating: 5,
        vendor_rating_reasons: ["Worth it"],
        vendor_review: "Nice one.",
        order_items_rating: [
          { item_id: 1110005, item_rating: 5 },
          { item_id: 1110006, item_rating: 5 },
        ],
        is_public: true,
      },
    ]);
    expect(report).toMatchObject({ outcome: "rated", outcome_uncertain: false });
    expect(report.message).toContain("successfully added rating/review");
  });

  test("a rating alone sends empty reasons, review and items, and a thumbs down as 1", async () => {
    route(`GET ${ORDER_PATH}`, delivered);
    route(`POST ${RATE_PATH}`, rated);

    await rate({ rating: 2, items: [{ item_id: 1110006, liked: false }], public: false });

    expect(sent("POST", RATE_PATH)[0]!.body).toEqual({
      vendor_rating: 2,
      vendor_rating_reasons: [],
      vendor_review: "",
      order_items_rating: [{ item_id: 1110006, item_rating: 1 }],
      is_public: false,
    });
  });

  test("refuses an item that is not in the order, sending nothing", async () => {
    route(`GET ${ORDER_PATH}`, delivered);

    const report = parse(await rate({ rating: 5, items: [{ item_id: 999, liked: true }] }));

    expect(report.outcome).toBe("not_sent");
    expect(report.message).toContain("item 999 is not part of this order");
    expect(sent("POST", RATE_PATH)).toHaveLength(0);
  });

  test("refuses an unpaid order, sending nothing", async () => {
    route(`GET ${ORDER_PATH}`, orderRecord());

    const report = parse(await rate({ rating: 5 }));

    expect(report.outcome).toBe("not_sent");
    expect(sent("POST", RATE_PATH)).toHaveLength(0);
  });

  test.each([0, 6, 4.5])("rejects a rating of %s before contacting Chowdeck", async (rating) => {
    const result = await rate({ rating });

    expect(result.isError).toBe(true);
    expect(mock.received).toHaveLength(0);
  });

  test("reports Chowdeck's refusal with its reason", async () => {
    route(`GET ${ORDER_PATH}`, delivered);
    route(`POST ${RATE_PATH}`, () => Response.json({ status: "failed", message: "Order already rated" }, { status: 422 }));

    const report = parse(await rate({ rating: 5 }));

    expect(report).toMatchObject({ outcome: "rejected_by_chowdeck", outcome_uncertain: false });
    expect(report.message).toContain("Order already rated");
  });

  test("an unclear answer is unknown and never resent", async () => {
    route(`GET ${ORDER_PATH}`, delivered);
    route(`POST ${RATE_PATH}`, slow(rated));

    const report = parse(await rate({ rating: 5 }, 100));

    expect(report).toMatchObject({ outcome: "unknown_outcome", outcome_uncertain: true, safe_to_retry: false });
    expect(sent("POST", RATE_PATH)).toHaveLength(1);
  });
});
