import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { jsonResult, textResult } from "../../utils/tool-result";
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

// The order options place_order accepts beside the quote's own inputs.
export const orderOptionsSchema = {
  tip: z
    .union([
      z.literal("none"),
      z.object({ amount_naira: z.number().describe("Tip in naira, e.g. 200 or 150.50; 0 means no tip") }).strict(),
    ])
    .optional()
    .describe('"none", or the tip amount the user chose. Never choose a tip for the user.'),
  gift: z
    .object({
      beneficiary_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("A saved recipient from list_beneficiaries; their name, phone and email are filled in"),
      donor_name: z.string().max(400).describe("Sender's name"),
      name: z.string().max(400).optional().describe("Recipient's name; not needed with beneficiary_id"),
      phone: z.string().max(40).optional().describe("Recipient's phone number; not needed with beneficiary_id"),
      country_code: z.string().max(10).optional().describe("Recipient's phone country, two letters; default NG"),
      email: z.string().max(400).optional(),
      message: z.string().max(2000).optional().describe("Gift message"),
      save_as_beneficiary: z.boolean().optional().describe("Save the recipient as a beneficiary; only if the user asks"),
    })
    .strict()
    .refine((gift) => gift.beneficiary_id !== undefined || (gift.name !== undefined && gift.phone !== undefined), {
      message: "give beneficiary_id, or the recipient's name and phone",
    })
    .optional()
    .describe("Send this order as a gift, delivered to the cart's address"),
};

const promoCodeInput = z.string().max(100);

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
        "Quote delivery and service fees for the signed-in user's cart at a restaurant, delivered to one of their saved addresses. Does not place an order or take payment. Show the user computed_total (and any promo discount and tip), then ask about everything in checkout_details.ask_the_user_about in one message, saying what is already set; place_order takes the total as quoted_total. Each call asks Chowdeck for a new delivery-fee quote, so call it once per checkout rather than repeatedly. With promo_code (a code on the user's account, see list_promo_codes), Chowdeck's discount calculation runs with this quote's delivery fee and the result is shown in promo; the quote is orderable only if Chowdeck returns a discount for the code. Amounts are in naira; computed_total and estimated_total_after_discount are calculated by ChowBot from Chowdeck's fees.",
      inputSchema: z.object({
        ...getCheckoutQuoteSchema,
        promo_code: promoCodeInput.optional().describe("A promo code on the user's account to apply in this quote"),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ restaurant_id, address_id, promo_code }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return jsonResult(await service.getQuote(restaurant_id, address_id, promo_code));
      } catch (error) {
        return failure("get checkout quote", "get_checkout_quote", error);
      }
    },
  );

  server.registerTool(
    "list_beneficiaries",
    {
      title: "List gift recipients",
      description:
        "List the people saved on the signed-in user's Chowdeck account as gift recipients (beneficiaries). To send an order to one, pass their id as gift.beneficiary_id to place_order with the sender's name; the order is delivered to the cart's address. Read-only.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const beneficiaries = await service.listBeneficiaries();
        return jsonResult({ returned: beneficiaries.length, beneficiaries });
      } catch (error) {
        return failure("list gift recipients", "list_beneficiaries", error);
      }
    },
  );

  server.registerTool(
    "list_promo_codes",
    {
      title: "List promo codes and vouchers",
      description:
        "List the promo codes and discounts (vouchers) on the signed-in user's Chowdeck account, with ChowBot's reading of each one's validity, expiry, usage and restaurant limits (pass restaurant_id to check the restaurant). This is not a promise of a discount: only Chowdeck's calculation in get_checkout_quote with promo_code confirms one. Read-only; does not add codes to the account.",
      inputSchema: z.object({
        restaurant_id: z.number().int().positive().optional().describe("Optional Chowdeck restaurant ID to check restaurant limits against"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return jsonResult(await service.listPromoCodes(restaurant_id));
      } catch (error) {
        return failure("list promo codes", "list_promo_codes", error);
      }
    },
  );
};
