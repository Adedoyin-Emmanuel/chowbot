import { z } from "zod";
import type { McpServer, RequestStateCodec } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import OrderPlacementService from "./service";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import { CheckoutRefusedError } from "../checkout/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import type { UserOrderSubmissions } from "../../lib/order-submissions";
import { SUPPORTED_PAYMENT_CHANNELS, type PaymentChannelQuery } from "./channels";

const quoteRef = z.string().uuid().describe("quote_ref from get_checkout_quote");

const placeOrderSchema = {
  quote_ref: quoteRef,
  address_id: z
    .number()
    .int()
    .positive()
    .describe("The delivery address used for the quote, from list_addresses"),
  payment_channel: z
    .enum(SUPPORTED_PAYMENT_CHANNELS)
    .describe("Online payment channel. The order is created unpaid; payment is completed separately."),
};

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(`Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`, true);
  }
  if (error instanceof CheckoutRefusedError || error instanceof ChowdeckApiError) {
    return textResult(`Failed to ${action}: ${error.message}`, true);
  }
  logger.error(`Unexpected error in ${tool}:`, error instanceof Error ? error.name : typeof error);
  return textResult(`Failed to ${action}: unexpected error`, true);
};

export type OrderPlacementOptions = {
  session?: UserSession;
  submissions?: UserOrderSubmissions;
  requestStateCodec?: RequestStateCodec;
  paymentChannelQuery?: PaymentChannelQuery;
  placeOrderEnabled?: boolean;
  client?: ChowdeckClient;
};

/*
 * Registered only on the hosted server, which has durable per-user
 * submission records. place_order additionally needs the explicit enablement
 * flag, the requestState codec and the payment-channel query; without any of
 * them it is not registered at all.
 */
export const registerOrderPlacementTools = (
  server: McpServer,
  { session, submissions, requestStateCodec, paymentChannelQuery, placeOrderEnabled, client }: OrderPlacementOptions,
) => {
  if (!session || !submissions) return;
  const service = new OrderPlacementService(
    session,
    submissions,
    client,
    requestStateCodec,
    paymentChannelQuery,
  );

  server.registerTool(
    "get_order_submission",
    {
      title: "Get order attempts",
      description:
        "Show the signed-in user's order attempts at a restaurant that still lock a cart, and check unpaid orders' payment status with Chowdeck. Releases attempts whose order request provably never started. Never releases attempts with an unknown outcome.",
      inputSchema: z.object({
        restaurant_id: z.number().int().positive().describe("Chowdeck restaurant ID"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ restaurant_id }) => {
      try {
        return await service.getStatus(restaurant_id);
      } catch (error) {
        return failure("get order attempts", "get_order_submission", error);
      }
    },
  );

  server.registerTool(
    "resolve_order_submission",
    {
      title: "Link an order to an attempt",
      description:
        "Link an order you found in the Chowdeck app to an order attempt whose outcome is unknown. The order is verified with Chowdeck first; the cart stays locked.",
      inputSchema: z.object({
        quote_ref: quoteRef,
        outcome: z.enum(["link_order"]).describe("link_order is the only supported recovery"),
        order_id: z.number().int().positive().describe("The order id shown in the Chowdeck app"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ quote_ref, order_id }) => {
      try {
        return await service.linkOrder(quote_ref, order_id);
      } catch (error) {
        return failure("link the order", "resolve_order_submission", error);
      }
    },
  );

  if (placeOrderEnabled !== true || !requestStateCodec || !paymentChannelQuery) return;

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Place a real Chowdeck delivery order from an orderable quote (quote_ref from get_checkout_quote). Asks the user to confirm the items, address, total and payment channel through the client before anything is sent. The order is created unpaid; payment is not started by ChowBot. Never call it again after an unknown outcome.",
      inputSchema: z.object(placeOrderSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      try {
        return await service.placeOrder(args, ctx);
      } catch (error) {
        return failure("place the order", "place_order", error);
      }
    },
  );
};
