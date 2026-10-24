import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { jsonResult, textResult } from "../../utils/tool-result";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import RestaurantService, { COLLECTIONS, SEARCH_TYPES } from "./service";

const addressId = z.number().int().positive().describe("Saved delivery address ID from list_addresses");

const limit = (fallback: number) =>
  z.number().int().min(1).max(50).default(fallback).describe("Maximum number of places to return");

const DELIVERY_NOTE =
  "A listing does not guarantee delivery: get_checkout_quote settles it, and Chowdeck may answer that a vendor cannot deliver to the address. Amounts are in naira; delivery times are minutes.";

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof ChowdeckApiError) return textResult(`Failed to ${action}: ${error.message}`, true);
  logger.error(`Unexpected error in ${tool}:`, error instanceof Error ? error.name : typeof error);
  return textResult(`Failed to ${action}: unexpected error`, true);
};

export const registerRestaurantTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = new RestaurantService(session, client);

  server.registerTool(
    "search_restaurants",
    {
      title: "Search restaurants and food",
      description: `Search Chowdeck as its search bar does, for a dish, product or place name (e.g. "shawarma", "jollof rice", "Item 7"). Returns the places that deliver around the address, each with the menu items that matched (matching_items) when the match was a dish. Use type to search only restaurants, supermarkets, pharmacies or Chowdeck's own store. ${DELIVERY_NOTE}`,
      inputSchema: z.object({
        address_id: addressId,
        query: z.string().trim().min(1).max(100).describe("What to search for"),
        type: z.enum(SEARCH_TYPES).optional().describe("Only this kind of place; leave out to search everything"),
        limit: limit(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address_id, query, type, limit }) => {
      try {
        return jsonResult(await service.search(address_id, query, type, limit));
      } catch (error) {
        return failure("search", "search_restaurants", error);
      }
    },
  );

  server.registerTool(
    "browse_restaurants",
    {
      title: "Browse restaurants",
      description: `List places around a delivery address without a search term. collection: nearby (everything Chowdeck lists, nearest first; pass next_cursor from a result for more), handpicked or featured (Chowdeck's picks), or order_again (the signed-in user's frequent places with what they last ordered). vendor_type and open_now filter the list. ${DELIVERY_NOTE}`,
      inputSchema: z.object({
        address_id: addressId,
        collection: z.enum(COLLECTIONS).default("nearby").describe("Which list to show"),
        vendor_type: z.string().trim().min(1).max(40).optional().describe('Only this kind of place, e.g. "restaurant", "supermarket" or "pharmacy"'),
        open_now: z.boolean().optional().describe("Only places open and taking orders now"),
        next_cursor: z.string().max(200).optional().describe("Only for nearby: next_cursor from the previous result, for the next page"),
        limit: limit(20),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ address_id, collection, vendor_type, open_now, next_cursor, limit }) => {
      try {
        return jsonResult(
          await service.browse(address_id, collection, { vendorType: vendor_type, openNow: open_now, limit }, next_cursor),
        );
      } catch (error) {
        return failure("browse restaurants", "browse_restaurants", error);
      }
    },
  );
};
