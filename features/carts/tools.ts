import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { NotSignedInError } from "../addresses/service";
import CartService, { CartRequestError, MAX_BAGS } from "./service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import OrderService from "../orders/service";

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

const packTargetSchema = {
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

/*
 * The active orders Chowdeck lists at a restaurant, read after clearing its
 * cart: an order is a copy of the cart, so clearing it cancels nothing.
 */
const activeOrdersAt = async (orders: OrderService, restaurantId: number) => {
  try {
    const active = (await orders.listOrders("active")).orders.filter((order) => order.vendor_id === restaurantId);
    return {
      active_orders_at_restaurant: active,
      active_orders_note:
        active.length === 0
          ? "Chowdeck lists no active orders at this restaurant."
          : 'Chowdeck lists these active orders at this restaurant. Clearing the cart did not change or cancel them. An unpaid order (Chowdeck shows unpaid orders with status "abandoned") is not charged unless someone pays it, but anyone holding its pay-for-me link still can. Check one with get_order; cancelling an order is done in the Chowdeck app.',
    };
  } catch (error) {
    if (error instanceof NotSignedInError) throw error;
    return {
      active_orders_note: `ChowBot could not read your active orders from Chowdeck (${error instanceof ChowdeckApiError ? error.message : "unexpected error"}), so it cannot say whether any exist at this restaurant. Clearing the cart does not cancel an order.`,
    };
  }
};

export const registerCartTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new CartService(session, client);
  const orders = session && new OrderService(session, client);

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
      description: `Get the signed-in user's cart for one restaurant. Items are grouped into packs; each pack is one menu item plus its chosen options. A cart Chowdeck links to an order or reports as not active is marked editable: false, and ChowBot does not change it. Orders already placed are copies of the cart: editing it does not change them. ${AMOUNTS_NOTE}`,
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

  const noteInput = z
    .string()
    .max(4000)
    .nullable()
    .optional();

  server.registerTool(
    "get_cart_notes",
    {
      title: "Get checkout notes",
      description:
        "Show the restaurant note and the delivery (rider) note saved on the signed-in user's cart for a restaurant. These are the notes an order from this cart would carry.",
      inputSchema: z.object({ restaurant_id: restaurantId }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.getNotes(restaurant_id)));
      } catch (error) {
        return failure("get checkout notes", "get_cart_notes", error);
      }
    },
  );

  server.registerTool(
    "set_cart_notes",
    {
      title: "Set checkout notes",
      description:
        "Set or clear the restaurant note (instructions for the restaurant) and/or the delivery note (instructions for the rider) on the signed-in user's existing cart for a restaurant. Give only the note(s) to change; null or an empty string clears one. Up to 500 characters each (ChowBot's limit). Saved on Chowdeck's cart, as the website does, and confirmed by re-reading the cart: only confirmed_by_chowdeck: true means it was saved. Set the notes before place_order: an order carries the notes saved on the cart when it is placed, and later note changes do not reach an order already placed. Does not place an order.",
      inputSchema: z.object({
        restaurant_id: restaurantId,
        vendor_note: noteInput.describe("Instructions for the restaurant; null or \"\" clears it"),
        delivery_note: noteInput.describe("Instructions for the delivery rider; null or \"\" clears it"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, vendor_note, delivery_note }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const notes = {
          ...(vendor_note !== undefined && { vendor: vendor_note }),
          ...(delivery_note !== undefined && { delivery: delivery_note }),
        };
        return textResult(JSON.stringify(await service.setNotes(restaurant_id, notes)));
      } catch (error) {
        return failure("set checkout notes", "set_cart_notes", error);
      }
    },
  );

  server.registerTool(
    "set_cart_bags",
    {
      title: "Set brown bags",
      description:
        "Set how many of Chowdeck's brown bags (paid packaging for the whole order) the signed-in user's cart at a restaurant gets; 0 removes them. Saved on Chowdeck's cart, as the website does, and confirmed by re-reading the cart: only confirmed_by_chowdeck: true means it was set. The bags change the cart total, so get a new checkout quote afterwards. Does not place an order.",
      inputSchema: z.object({
        restaurant_id: restaurantId,
        quantity: z.number().int().min(0).max(MAX_BAGS).describe("Number of bags; 0 for none"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, quantity }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return textResult(JSON.stringify(await service.setBags(restaurant_id, quantity)));
      } catch (error) {
        return failure("set the bags", "set_cart_bags", error);
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
      inputSchema: z.object(packTargetSchema),
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

  server.registerTool(
    "remove_cart_pack",
    {
      title: "Remove cart pack",
      description: `Remove one pack (a menu item with its options) from the signed-in user's cart for a restaurant. Other packs are left unchanged. Returns the cart as Chowdeck reports it afterwards, or cart_exists: false if no cart remains. ${AMOUNTS_NOTE}`,
      inputSchema: z.object(packTargetSchema),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ restaurant_id, pack_reference }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.removePack(restaurant_id, pack_reference);
        return textResult(JSON.stringify(result));
      } catch (error) {
        return failure("remove cart pack", "remove_cart_pack", error);
      }
    },
  );

  server.registerTool(
    "clear_cart",
    {
      title: "Clear cart",
      description:
        "Delete the signed-in user's whole cart for one restaurant: use it when the user wants to empty or abandon an unpaid cart. Carts at other restaurants are not affected. Does nothing if there is no cart. Clearing a cart never cancels an order already placed from it; the result lists the active orders Chowdeck shows at the restaurant so they can be reported accurately.",
      inputSchema: z.object({ restaurant_id: restaurantId }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ restaurant_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.clearCart(restaurant_id);
        return textResult(JSON.stringify({ ...result, ...(await activeOrdersAt(orders!, restaurant_id)) }));
      } catch (error) {
        return failure("clear cart", "clear_cart", error);
      }
    },
  );
};
