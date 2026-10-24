import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import OrderPlacementService from "./service";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import { orderOptionsSchema } from "../checkout/tools";
import { pocketTagSchema } from "../payments/tools";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import type { PaymentStartConfig } from "../payments/service";
import { ORDER_PAYMENT_CHOICES, type PaymentChannelQuery } from "./channels";

const placeOrderSchema = {
  restaurant_id: z.number().int().positive().describe("Chowdeck restaurant ID whose cart to order"),
  address_id: z.number().int().positive().describe("The delivery address used for the quote, from list_addresses"),
  quoted_total: z
    .number()
    .positive()
    .describe("The computed_total from get_checkout_quote in naira, as shown to the user (e.g. 6518.37); nothing is sent if the total has changed"),
  payment_channel: z
    .enum(ORDER_PAYMENT_CHOICES)
    .describe(
      "How the user chose to pay. Online channels (card, bank_transfer, bank, ussd, opay, pocket, zap): the order is created unpaid and a payment link is returned. wallet: paid from the Chowdeck wallet balance at creation. pay_for_me: created unpaid with a link to share with whoever will pay.",
    ),
  pocket_tag: pocketTagSchema.optional().describe("Only for pocket: the payer's PocketApp tag"),
  promo_code: z.string().max(100).optional().describe("The promo code used in get_checkout_quote, if any"),
  ...orderOptionsSchema,
};

const failure = (error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult("Failed to place the order: not signed in to Chowdeck. Sign in, then try again.", true);
  }
  if (error instanceof ChowdeckApiError) {
    return textResult(`Failed to place the order: ${error.message}. Nothing was sent.`, true);
  }
  logger.error("Unexpected error in place_order:", error instanceof Error ? error.name : typeof error);
  return textResult("Failed to place the order: unexpected error", true);
};

export type OrderPlacementOptions = {
  session?: UserSession;
  paymentChannelQuery?: PaymentChannelQuery;
  paymentStartConfig?: PaymentStartConfig;
  placeOrderEnabled?: boolean;
  client?: ChowdeckClient;
};

/*
 * Registered only when live ordering is enabled with the payment-channel
 * query and the payment-start redirects.
 */
export const registerOrderPlacementTools = (
  server: McpServer,
  { session, paymentChannelQuery, paymentStartConfig, placeOrderEnabled, client }: OrderPlacementOptions,
) => {
  if (!session || placeOrderEnabled !== true || !paymentChannelQuery || !paymentStartConfig) return;
  const service = new OrderPlacementService(session, paymentChannelQuery, paymentStartConfig, client);

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Place a real Chowdeck delivery order from the signed-in user's cart at a restaurant. Call it only when the user has asked to place the order, after they have seen the get_checkout_quote total and been offered its checkout_details options; do not ask them to confirm again. The cart, address, restaurant, fees and any promo code are re-checked with Chowdeck first, and nothing is sent if the total differs from quoted_total. The order carries the notes saved on the cart (set_cart_notes) and any tip or gift given here; never choose a tip for the user. For an online channel the result includes a payment_link to give the user; pay_for_me returns pay_for_me_link; wallet is charged by Chowdeck at creation. Statuses and totals come from Chowdeck's order record. Until an order is paid the user can change anything (notes, tip, bags, items, address, payment channel): update the cart and call place_order again; the unpaid order stays unpaid and is never charged, as on the Chowdeck website. A paid order is final. Sent once and never retried; after unknown_outcome, follow its next_step.",
      inputSchema: z.object(placeOrderSchema),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return await service.placeOrder(args);
      } catch (error) {
        return failure(error);
      }
    },
  );
};
