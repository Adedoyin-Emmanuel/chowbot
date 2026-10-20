import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import CheckoutService, {
  CheckoutRefusedError,
  PREVIEW_PAYMENT_METHODS,
} from "./service";
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

const previewOrderSchema = {
  ...getCheckoutQuoteSchema,
  payment_method: z
    .enum(PREVIEW_PAYMENT_METHODS)
    .describe(
      "wallet, or pay_for_me (someone else pays through a share link). Pay online is not supported yet.",
    ),
};

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(
      `Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`,
      true,
    );
  }
  if (error instanceof CheckoutRefusedError || error instanceof ChowdeckApiError) {
    return textResult(`Failed to ${action}: ${error.message}`, true);
  }
  logger.error(
    `Unexpected error in ${tool}:`,
    error instanceof Error ? error.name : typeof error,
  );
  return textResult(`Failed to ${action}: unexpected error`, true);
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
        return failure("get checkout quote", "get_checkout_quote", error);
      }
    },
  );

  server.registerTool(
    "preview_order",
    {
      title: "Preview order (dry run)",
      description:
        "Dry run only: checks the signed-in user's cart, address, restaurant and payment choice, and shows the delivery order ChowBot would send to Chowdeck. It never places an order, requests a delivery-fee quote, starts a payment or changes the cart. Private values in the preview are withheld.",
      inputSchema: z.object(previewOrderSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, address_id, payment_method }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(
          JSON.stringify(
            await service.previewOrder(restaurant_id, address_id, payment_method),
          ),
        );
      } catch (error) {
        return failure("preview order", "preview_order", error);
      }
    },
  );
};
