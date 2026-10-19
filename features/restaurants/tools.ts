import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import RestaurantService from "./service";
import { logger } from "../../utils/logger";
import { textResult } from "../../utils/tool-result";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const searchRestaurantsSchema = {
  address_id: z
    .number()
    .int()
    .positive()
    .describe("Chowdeck delivery address ID to search around"),
  query: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Optional restaurant name or cuisine to filter by"),
  page: z.number().int().positive().optional().describe("Results page number"),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(20)
    .describe("Maximum number of restaurants to return"),
};

export const registerRestaurantTools = (
  server: McpServer,
  client?: ChowdeckClient,
) => {
  const service = new RestaurantService(client);

  server.registerTool(
    "search_restaurants",
    {
      title: "Search restaurants",
      description:
        "List Chowdeck restaurants that deliver to a saved delivery address. Fields are passed through from Chowdeck only when present.",
      inputSchema: z.object(searchRestaurantsSchema),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address_id, query, page, limit }) => {
      try {
        const result = await service.search({
          addressId: address_id,
          query,
          page,
          limit,
        });
        return textResult(JSON.stringify(result));
      } catch (error) {
        if (error instanceof ChowdeckApiError) {
          return textResult(`Failed to search restaurants: ${error.message}`, true);
        }
        logger.error("Unexpected error in search_restaurants:", error);
        return textResult("Failed to search restaurants: unexpected error", true);
      }
    },
  );
};
