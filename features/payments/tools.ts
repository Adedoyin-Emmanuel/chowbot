import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { SUPPORTED_PAYMENT_CHANNELS } from "../order-placement/channels";
import PaymentService, { type PaymentStartConfig } from "./service";

export type PaymentOptions = {
  session?: UserSession;
  paymentStartConfig?: PaymentStartConfig;
  client?: ChowdeckClient;
};

export const pocketTagSchema = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9_.]{1,40}$/, "a Pocket tag has letters, digits, underscores or dots");

/*
 * Registered only with the payment-start redirect URLs, which the hosted
 * server sets when live ordering is on.
 */
export const registerPaymentTools = (
  server: McpServer,
  { session, paymentStartConfig, client }: PaymentOptions,
) => {
  if (!session || !paymentStartConfig) return;
  const service = new PaymentService(session, paymentStartConfig, client);

  server.registerTool(
    "start_payment",
    {
      title: "Start payment",
      description:
        "Get a new payment link for one of the signed-in user's unpaid Chowdeck orders (order_id from place_order or list_orders). place_order already returns a link for online channels, so use this only when that link is missing, failed or lost. To pay with a different channel, place the order again with that payment_channel instead. Chowdeck's order record is read first: a paid, cancelled or pay-for-me order gets no payment. Use the payment channel the order was placed with; pocket needs the payer's pocket_tag. Sent once and never retried: after an unknown outcome, check the order with get_order before calling it again. Payment is confirmed only when get_order shows it.",
      inputSchema: z.object({
        order_id: z.number().int().positive().describe("The Chowdeck order id"),
        payment_channel: z.enum(SUPPORTED_PAYMENT_CHANNELS).describe("The online channel the order was placed with"),
        pocket_tag: pocketTagSchema.optional().describe("Only for pocket: the payer's PocketApp tag, as the user gives it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return await service.startPayment(args);
      } catch (error) {
        if (error instanceof NotSignedInError) {
          return textResult("Failed to start the payment: not signed in to Chowdeck. Sign in, then try again.", true);
        }
        if (error instanceof ChowdeckApiError) {
          return textResult(`Failed to start the payment: a Chowdeck request failed (${error.message}).`, true);
        }
        logger.error("Unexpected error in start_payment:", error instanceof Error ? error.name : typeof error);
        return textResult("Failed to start the payment: unexpected error", true);
      }
    },
  );
};
