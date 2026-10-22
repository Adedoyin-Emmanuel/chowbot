import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import type { UserOrderSubmissions } from "../../lib/order-submissions";
import PaymentStartService, { type PaymentStartConfig } from "./service";

export type PaymentOptions = {
  session?: UserSession;
  submissions?: UserOrderSubmissions;
  paymentStartConfig?: PaymentStartConfig;
  client?: ChowdeckClient;
};

/*
 * Registered only on the hosted server with durable submission records and
 * the payment-start redirect URLs. Without the URLs start_payment is not
 * registered at all.
 */
export const registerPaymentTools = (
  server: McpServer,
  { session, submissions, paymentStartConfig, client }: PaymentOptions,
) => {
  if (!session || !submissions || !paymentStartConfig) return;
  const service = new PaymentStartService(session, submissions, paymentStartConfig, client);

  server.registerTool(
    "start_payment",
    {
      title: "Start payment",
      description:
        "Start the online payment for an unpaid order ChowBot placed (quote_ref from place_order). On success the result contains a payment_link (https) from Chowdeck: show it to the user as a clickable link to open and pay, then check payment with get_order_submission. ChowBot starts at most one payment per order and never retries: if Chowdeck refuses, or the outcome is unknown, there is no link and the user pays in the Chowdeck app. Payment is confirmed only from Chowdeck's order record, never from the link.",
      inputSchema: z.object({
        quote_ref: z.string().uuid().describe("quote_ref of the order placed with place_order"),
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
