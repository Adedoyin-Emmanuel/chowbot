import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import OrderService from "./service";
import { logger } from "../../utils/logger";
import { textResult } from "../../utils/tool-result";
import type { UserSession } from "../../lib/session";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const SESSION_UNAVAILABLE =
  "Orders are not available on this connection: the server cannot identify individual users on this transport.";

const AMOUNTS_NOTE =
  "Amounts are Chowdeck's raw values, passed through without unit conversion.";

/*
 * Order IDs are redacted in the capture, so both a positive integer and a
 * short path-safe string are accepted and normalized to a string.
 */
const orderIdSchema = {
  order_id: z
    .union([
      z.number().int().positive(),
      z
        .string()
        .regex(
          /^[A-Za-z0-9_-]{1,64}$/,
          "Expected an order id from list_orders",
        ),
    ])
    .describe("Order ID, as returned by list_orders"),
};

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(
      `Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`,
      true,
    );
  }
  if (error instanceof ChowdeckApiError) {
    return textResult(`Failed to ${action}: ${error.message}`, true);
  }
  logger.error(
    `Unexpected error in ${tool}:`,
    error instanceof Error ? error.name : typeof error,
  );
  return textResult(`Failed to ${action}: unexpected error`, true);
};

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export const registerOrderTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new OrderService(session, client);

  server.registerTool(
    "list_orders",
    {
      title: "List completed orders",
      description: `List the signed-in user's completed Chowdeck orders as summaries. Only completed orders can be listed. ${AMOUNTS_NOTE}`,
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.listOrders()));
      } catch (error) {
        return failure("list orders", "list_orders", error);
      }
    },
  );

  server.registerTool(
    "get_order",
    {
      title: "Get order",
      description: `Get one of the signed-in user's Chowdeck orders: status, items, amounts and payment state. Statuses are passed through as Chowdeck reports them. ${AMOUNTS_NOTE}`,
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(
          JSON.stringify(await service.getOrder(String(order_id))),
        );
      } catch (error) {
        return failure("get order", "get_order", error);
      }
    },
  );

  server.registerTool(
    "get_order_timeline",
    {
      title: "Get order timeline",
      description:
        "Get the customer-facing progress steps of one of the signed-in user's Chowdeck orders, as Chowdeck reports them.",
      inputSchema: z.object(orderIdSchema),
      annotations: READ_ONLY,
    },
    async ({ order_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(
          JSON.stringify(await service.getOrderTimeline(String(order_id))),
        );
      } catch (error) {
        return failure("get order timeline", "get_order_timeline", error);
      }
    },
  );
};
