import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import MenuService from "./service";
import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const getRestaurantMenuSchema = {
  restaurant_id: z
    .number()
    .int()
    .positive()
    .describe("Chowdeck restaurant ID, as returned by search_restaurants"),
  category: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Only return items whose category name contains this text"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Maximum number of menu items to return"),
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
        "List menu items for a Chowdeck restaurant. Fields are passed through from Chowdeck only when present; prices are returned as Chowdeck sends them.",
      inputSchema: z.object(getRestaurantMenuSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ restaurant_id, category, limit }) => {
      try {
        const result = await service.getRestaurantMenu({
          restaurantId: restaurant_id,
          category,
          limit,
        });
        return textResult(JSON.stringify(result));
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
};
