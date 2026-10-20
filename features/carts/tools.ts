import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import CartService, { CartRequestError } from "./service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const SESSION_UNAVAILABLE =
  "Carts are not available on this connection: the server cannot identify individual users on this transport.";

const AMOUNTS_NOTE = "Amounts are Chowdeck's raw values, passed through without unit conversion.";

const restaurantId = z
  .number()
  .int()
  .positive()
  .describe("Chowdeck restaurant ID, as returned by search_restaurants");

const addToCartSchema = {
  restaurant_id: restaurantId,
  address_id: z
    .number()
    .int()
    .positive()
    .describe("Delivery address ID, as returned by list_addresses"),
  menu_item_id: z
    .number()
    .int()
    .positive()
    .describe("Menu item ID, as returned by get_restaurant_menu or get_menu_item"),
  quantity: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(1)
    .describe("How many of this item to add"),
  modifiers: z
    .array(
      z.object({
        group_id: z.number().int().positive().describe("Option group ID from get_menu_item"),
        option_id: z.number().int().positive().describe("Option ID within that group"),
      }),
    )
    .max(50)
    .default([])
    .describe("One entry per chosen option. Every group with minimum_selection > 0 must be satisfied."),
};

const duplicatePackSchema = {
  restaurant_id: restaurantId,
  pack_reference: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,100}$/, "Expected a pack_reference from get_cart")
    .describe("Pack reference from get_cart, e.g. pack-6b8c66fb-..."),
};

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(`Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`, true);
  }
  if (error instanceof CartRequestError || error instanceof ChowdeckApiError) {
    return textResult(`Failed to ${action}: ${error.message}`, true);
  }
  logger.error(
    `Unexpected error in ${tool}:`,
    error instanceof Error ? error.name : typeof error,
  );
  return textResult(`Failed to ${action}: unexpected error`, true);
};

export const registerCartTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new CartService(session, client);

  server.registerTool(
    "list_carts",
    {
      title: "List carts",
      description: `List the signed-in user's active Chowdeck carts, one per restaurant. ${AMOUNTS_NOTE}`,
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.listCarts()));
      } catch (error) {
        return failure("list carts", "list_carts", error);
      }
    },
  );

  server.registerTool(
    "get_cart",
    {
      title: "Get cart",
      description: `Get the signed-in user's cart for one restaurant. Items are grouped into packs; each pack is one menu item plus its chosen options. ${AMOUNTS_NOTE}`,
      inputSchema: z.object({ restaurant_id: restaurantId }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.getVendorCart(restaurant_id)));
      } catch (error) {
        return failure("get cart", "get_cart", error);
      }
    },
  );

  server.registerTool(
    "add_to_cart",
    {
      title: "Add to cart",
      description: `Add a menu item with its chosen options to the signed-in user's cart for a restaurant, creating the cart if needed. Each call adds a new pack; it never merges with existing packs. Options are checked against get_menu_item before anything is written. Returns the cart as Chowdeck reports it afterwards. ${AMOUNTS_NOTE}`,
      inputSchema: z.object(addToCartSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ restaurant_id, address_id, menu_item_id, quantity, modifiers }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.addToCart({
          restaurantId: restaurant_id,
          addressId: address_id,
          menuItemId: menu_item_id,
          quantity,
          modifiers: modifiers.map(({ group_id, option_id }) => ({ groupId: group_id, optionId: option_id })),
        });
        return textResult(JSON.stringify(result));
      } catch (error) {
        return failure("add to cart", "add_to_cart", error);
      }
    },
  );

  server.registerTool(
    "duplicate_cart_pack",
    {
      title: "Duplicate cart pack",
      description: `Add one more copy of an existing pack (a menu item with its options) to the signed-in user's cart for a restaurant. The copy gets its own pack_reference; the original is unchanged. Returns the cart as Chowdeck reports it afterwards. ${AMOUNTS_NOTE}`,
      inputSchema: z.object(duplicatePackSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ restaurant_id, pack_reference }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.duplicatePack(
          restaurant_id,
          pack_reference,
        );
        return textResult(JSON.stringify(result));
      } catch (error) {
        return failure("duplicate cart pack", "duplicate_cart_pack", error);
      }
    },
  );
};
