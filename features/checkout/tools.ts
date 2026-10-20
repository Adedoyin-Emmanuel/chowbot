import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import CheckoutService, { CheckoutRefusedError } from "./service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const SESSION_UNAVAILABLE =
  "Checkout is not available on this connection: the server cannot identify individual users on this transport.";

const getCheckoutQuoteSchema = {
  restaurant_id: z
    .number()
    .int()
    .positive()
    .describe("Chowdeck restaurant ID whose cart should be quoted"),
  address_id: z
    .number()
    .int()
    .positive()
    .describe("Delivery address ID, as returned by list_addresses"),
};

const failure = (error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(
      "Failed to get checkout quote: not signed in to Chowdeck. Sign in, then try again.",
      true,
    );
  }
  if (error instanceof CheckoutRefusedError || error instanceof ChowdeckApiError) {
    return textResult(`Failed to get checkout quote: ${error.message}`, true);
  }
  logger.error(
    "Unexpected error in get_checkout_quote:",
    error instanceof Error ? error.name : typeof error,
  );
  return textResult("Failed to get checkout quote: unexpected error", true);
};

export const registerCheckoutTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new CheckoutService(session, client);

  server.registerTool(
    "get_checkout_quote",
    {
      title: "Get checkout quote",
      description:
        "Quote delivery and service fees for the signed-in user's cart at a restaurant, delivered to one of their saved addresses. Does not place an order or take payment. Each call asks Chowdeck for a new delivery-fee quote, which appears to create a fee record on Chowdeck's side, so call it once per checkout rather than repeatedly. Amounts are Chowdeck's raw values without unit conversion; computed_total is calculated by ChowBot, not returned by Chowdeck.",
      inputSchema: z.object(getCheckoutQuoteSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ restaurant_id, address_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(
          JSON.stringify(await service.getQuote(restaurant_id, address_id)),
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
};
