import { z } from "zod";
import type { McpServer, RequestStateCodec } from "@modelcontextprotocol/server";

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
  requestStateCodec?: RequestStateCodec;
  paymentStartConfig?: PaymentStartConfig;
  client?: ChowdeckClient;
};

/*
 * Registered only on the hosted server with durable submission records, the
 * requestState codec and the payment-start redirect URLs. Without the URLs
 * (not yet observed) start_payment is not registered at all.
 */
export const registerPaymentTools = (
  server: McpServer,
  { session, submissions, requestStateCodec, paymentStartConfig, client }: PaymentOptions,
) => {
  if (!session || !submissions || !requestStateCodec || !paymentStartConfig) return;
  const service = new PaymentStartService(session, submissions, requestStateCodec, paymentStartConfig, client);

  server.registerTool(
    "start_payment",
    {
      title: "Start payment",
      description:
        "Start the online payment for an unpaid order ChowBot placed (quote_ref from place_order). The payment page is offered to the user through the client as a link; it is never shown in the conversation. ChowBot starts at most one payment per order and never retries; payment is confirmed only from Chowdeck's order record with get_order_submission.",
      inputSchema: z.object({
        quote_ref: z.string().uuid().describe("quote_ref of the order placed with place_order"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, ctx) => {
      try {
        return await service.startPayment(args, ctx);
      } catch (error) {
        if (error instanceof NotSignedInError) {
          return textResult("Failed to start the payment: not signed in to Chowdeck. Sign in, then try again.", true);
        }
        if (error instanceof ChowdeckApiError) {
          return textResult(`Failed to start the payment: ${error.message}`, true);
        }
        logger.error("Unexpected error in start_payment:", error instanceof Error ? error.name : typeof error);
        return textResult("Failed to start the payment: unexpected error", true);
      }
    },
  );
};
