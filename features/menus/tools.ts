import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import MenuService, { MENU_SECTIONS } from "./service";
import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { jsonResult, textResult } from "../../utils/tool-result";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const getRestaurantMenuSchema = {
  restaurant_id: z
    .number()
    .int()
    .positive()
    .describe("Chowdeck restaurant ID, from search_restaurants or browse_restaurants"),
  category: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Only return items whose category name contains this text"),
  section: z
    .enum(MENU_SECTIONS)
    .optional()
    .describe("popular: the restaurant's popular items; order_again: what the signed-in user ordered there before"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Maximum number of menu items to return"),
};

const getMenuItemSchema = {
  restaurant_id: z
    .number()
    .int()
    .positive()
    .describe("Chowdeck restaurant ID, from search_restaurants or browse_restaurants"),
  menu_item_id: z
    .number()
    .int()
    .positive()
    .describe("Menu item id, as returned by get_restaurant_menu"),
};

export const registerMenuTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = new MenuService(session, client);

  server.registerTool(
    "get_restaurant_menu",
    {
      title: "Get restaurant menu",
      description:
        "List menu items for a Chowdeck restaurant (restaurant_id from search_restaurants or browse_restaurants). Use section popular for what the restaurant is known for, or order_again for what the user ordered there before. Fields are passed through from Chowdeck only when present; prices are in naira.",
      inputSchema: z.object(getRestaurantMenuSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, category, section, limit }) => {
      try {
        const result = await service.getRestaurantMenu({
          restaurantId: restaurant_id,
          category,
          section,
          limit,
        });
        return jsonResult(result);
      } catch (error) {
        if (error instanceof ChowdeckApiError) {
          return textResult(`Failed to get restaurant menu: ${error.message}`, true);
        }
        logger.error(
          "Unexpected error in get_restaurant_menu:",
          error instanceof Error ? error.name : typeof error,
        );
        return textResult("Failed to get restaurant menu: unexpected error", true);
      }
    },
  );

  server.registerTool(
    "get_menu_item",
    {
      title: "Get menu item details",
      description:
        "Get one Chowdeck menu item with its option groups. minimum_selection > 0 marks a required group; minimum_selection and maximum_selection bound how many options may be chosen. Availability flags are passed through as Chowdeck sends them; prices are in naira.",
      inputSchema: z.object(getMenuItemSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, menu_item_id }) => {
      try {
        const result = await service.getMenuItem({
          restaurantId: restaurant_id,
          menuItemId: menu_item_id,
        });
        return jsonResult(result);
      } catch (error) {
        if (error instanceof ChowdeckApiError) {
          return textResult(`Failed to get menu item: ${error.message}`, true);
        }
        logger.error(
          "Unexpected error in get_menu_item:",
          error instanceof Error ? error.name : typeof error,
        );
        return textResult("Failed to get menu item: unexpected error", true);
      }
    },
  );
};
