import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import type { UserOrderSubmissions } from "../../lib/order-submissions";
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

/*
 * Checkout extras shared by preview_order and place_order, so both accept
 * and validate exactly the same values.
 */
export const checkoutDraftSchema = {
  promo_code: z
    .string()
    .max(100)
    .optional()
    .describe("A promo code the user wants to use. It is submitted only if Chowdeck's discount calculation shows a discount."),
  tip: z
    .union([
      z.literal("none"),
      z.object({ amount_naira: z.number().describe("Tip in naira, e.g. 200 or 150.50; 0 means no tip") }).strict(),
    ])
    .optional()
    .describe('"none", or the tip amount the user chose. Never choose a tip for the user.'),
  gift: z
    .object({
      donor_name: z.string().max(400).describe("Sender's name"),
      name: z.string().max(400).describe("Recipient's name"),
      phone: z.string().max(40).describe("Recipient's phone number"),
      country_code: z.string().max(10).optional().describe("Recipient's phone country, two letters; default NG"),
      email: z.string().max(400).optional(),
      message: z.string().max(2000).optional().describe("Gift message"),
      save_as_beneficiary: z.boolean().optional().describe("Save the recipient as a beneficiary; only if the user asks"),
    })
    .strict()
    .optional()
    .describe("Send this order as a gift, delivered to the cart's address"),
};

const previewOrderSchema = {
  ...getCheckoutQuoteSchema,
  payment_method: z
    .enum(PREVIEW_PAYMENT_METHODS)
    .describe(
      "wallet, or pay_for_me (someone else pays through a share link). Pay online is not supported yet.",
    ),
  ...checkoutDraftSchema,
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
  submissions?: UserOrderSubmissions,
) => {
  const service = session && new CheckoutService(session, client, submissions);

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
    "check_promo_code",
    {
      title: "Check a promo code",
      description:
        "Ask Chowdeck's discount calculation what a promo code would take off the signed-in user's cart at a restaurant, compared with no code. Builds the request exactly as the Chowdeck website does; delivery-fee discounts are not included because no fee quote is requested. A result is Chowdeck's calculation, not a guarantee: the discount is only final in the order. Does not add the code to the account, change the cart or place an order.",
      inputSchema: z.object({
        ...getCheckoutQuoteSchema,
        promo_code: z.string().max(100).describe("The promo code to check"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, address_id, promo_code }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.checkPromoCode(restaurant_id, address_id, promo_code)));
      } catch (error) {
        return failure("check the promo code", "check_promo_code", error);
      }
    },
  );

  server.registerTool(
    "preview_order",
    {
      title: "Preview order (dry run)",
      description:
        "Dry run only: checks the signed-in user's cart, address, restaurant and payment choice, and shows the delivery order ChowBot would send to Chowdeck, including the cart's notes and any promo code, tip or gift details given here. checkout_draft separates what Chowdeck confirmed from what the user provided and what is unconfirmed. It never places an order, requests a delivery-fee quote, starts a payment or changes the cart. Fee and address ids are withheld.",
      inputSchema: z.object(previewOrderSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, address_id, payment_method, promo_code, tip, gift }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(
          JSON.stringify(
            await service.previewOrder(restaurant_id, address_id, payment_method, {
              ...(promo_code !== undefined && { promo_code }),
              ...(tip !== undefined && { tip }),
              ...(gift !== undefined && { gift }),
            }),
          ),
        );
      } catch (error) {
        return failure("preview order", "preview_order", error);
      }
    },
  );
};
