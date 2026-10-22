import { z } from "zod";
import type { McpServer, RequestStateCodec } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import OrderPlacementService, { type CancelOrderArgs, type PlaceOrderArgs } from "./service";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import { CheckoutRefusedError } from "../checkout/service";
import { orderOptionsSchema } from "../checkout/tools";
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
    .describe(
      "Online payment channel the user chose: card, bank_transfer, bank or ussd (Paystack checkout), opay, pocket (PocketApp; start_payment then needs their Pocket tag) or zap. The order is created unpaid; payment is completed separately with start_payment.",
    ),
  ...orderOptionsSchema,
  promo_code: z
    .string()
    .max(100)
    .optional()
    .describe("Leave out: the promo code comes from the quote. If given, it must be the code the quote applied."),
  confirmation: z
    .string()
    .max(4096)
    .optional()
    .describe("Only in the second call: the confirmation value from the first call's summary, after the user explicitly said yes to it"),
  acknowledge_unresolved_attempts: z
    .boolean()
    .optional()
    .describe("Only when the summary asked for it and the user accepted the warning about earlier order attempts"),
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
        "Show the signed-in user's order attempts at a restaurant that still lock a cart, each with its current state read freshly from Chowdeck's order record (order_created, payment_link_generated, payment_pending, payment_confirmed, cancelled or unknown) and that state's source. Records payment or cancellation only from Chowdeck's order record. Releases attempts whose order request provably never started. Never releases attempts with an unknown outcome.",
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
        "Place a real Chowdeck delivery order from an orderable quote (quote_ref from get_checkout_quote). The user must confirm the restaurant, items, delivery address, quoted total, payment channel, notes and any order options before anything is sent. The first call without confirmation places nothing and returns the full summary plus a confirmation value; show that entire summary to the user and only if they explicitly say yes, call place_order again with the same arguments plus confirmation. This two-call confirmation works without client-specific confirmation UI. The order is created unpaid; payment is not started here. The restaurant and delivery notes are the ones saved on the cart (set them first with set_cart_notes). A promo code comes from the quote (get_checkout_quote with promo_code); an optional tip or gift recipient is shown in the confirmation and sent with the order, and ChowBot never adds a tip itself. After creation the result reports Chowdeck's own order record (state, total, notes). Never call it again after an unknown outcome.",
      inputSchema: z.object(placeOrderSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      try {
        return await service.placeOrder(args as PlaceOrderArgs, ctx);
      } catch (error) {
        return failure("place the order", "place_order", error);
      }
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel an unpaid order",
      description:
        "Cancel a Chowdeck order ChowBot placed (quote_ref from place_order) that Chowdeck's order record shows is not paid. The first call sends nothing: it reads the order from Chowdeck and returns a summary plus a confirmation value; only if the user explicitly says yes, call it again with the same quote_ref plus confirmation. ChowBot sends one cancellation request and never retries; the order counts as cancelled only when Chowdeck's order record shows it. A paid order cannot be cancelled here. Editing or clearing the cart never cancels an order.",
      inputSchema: z.object({
        quote_ref: quoteRef.describe("quote_ref of the order placed with place_order"),
        confirmation: z
          .string()
          .max(4096)
          .optional()
          .describe("Only in the second call: the confirmation value from the first call, after the user explicitly said yes"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      try {
        return await service.cancelOrder(args as CancelOrderArgs, ctx);
      } catch (error) {
        return failure("cancel the order", "cancel_order", error);
      }
    },
  );
};
