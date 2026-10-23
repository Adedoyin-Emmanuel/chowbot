import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { jsonResult, textResult } from "../../utils/tool-result";
import AddressService, { NotSignedInError } from "./service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import { MIN_PLACE_QUERY_LENGTH } from "./places";
import { DUPLICATE_TOKEN_PATTERN } from "./duplicates";

const SESSION_UNAVAILABLE =
  "Addresses are not available on this connection: the server cannot identify individual users on this transport.";

const NOT_SIGNED_IN =
  "Failed to list addresses: not signed in to Chowdeck. Sign in, then try again.";

/*
 * Errors for the place-search and address-creation tools: only Chowdeck's
 * short message or the error name, never request data.
 */
const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof NotSignedInError) {
    return textResult(`Failed to ${action}: not signed in to Chowdeck. Sign in, then try again.`, true);
  }
  if (error instanceof ChowdeckApiError) return textResult(`Failed to ${action}: ${error.message}`, true);
  logger.error(`Unexpected error in ${tool}:`, error instanceof Error ? error.name : typeof error);
  return textResult(`Failed to ${action}: unexpected error`, true);
};

export const registerAddressTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new AddressService(session, client);

  server.registerTool(
    "list_addresses",
    {
      title: "List delivery addresses",
      description:
        "List the signed-in user's saved Chowdeck delivery addresses. Use an address id as address_id for search_restaurants. Fields are passed through from Chowdeck only when present.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.list();
        return jsonResult(result);
      } catch (error) {
        if (error instanceof NotSignedInError) return textResult(NOT_SIGNED_IN, true);
        if (error instanceof ChowdeckApiError) {
          return textResult(`Failed to list addresses: ${error.message}`, true);
        }
        logger.error(
          "Unexpected error in list_addresses:",
          error instanceof Error ? error.name : typeof error,
        );
        return textResult("Failed to list addresses: unexpected error", true);
      }
    },
  );

  server.registerTool(
    "set_active_address",
    {
      title: "Switch the active delivery address",
      description:
        "Make one of the signed-in user's saved addresses (address_id from list_addresses) their active Chowdeck delivery address, as the website's address switcher does. Use it when the user asks to switch or change their address. Confirmed only when Chowdeck's address list, read again, shows it as current. Restaurant search, carts and quotes still take address_id explicitly, so pass the same address there.",
      inputSchema: z.object({
        address_id: z.number().int().positive().describe("The saved address to make active, from list_addresses"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ address_id }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.setActive(address_id);
        return jsonResult(result, !["activated", "already_active"].includes(result.status));
      } catch (error) {
        return failure("switch the address", "set_active_address", error);
      }
    },
  );

  server.registerTool(
    "search_address_places",
    {
      title: "Search for an address",
      description:
        "Search Chowdeck's place suggestions for a new delivery address. Returns place_id values to pass to add_address after the user picks one. Read-only: nothing is saved.",
      inputSchema: z.object({
        query: z
          .string()
          .trim()
          .min(MIN_PLACE_QUERY_LENGTH, `Enter at least ${MIN_PLACE_QUERY_LENGTH} characters`)
          .max(200)
          .describe("Street, area or landmark to search for"),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return jsonResult(await service.searchPlaces(query));
      } catch (error) {
        return failure("search for places", "search_address_places", error);
      }
    },
  );

  server.registerTool(
    "add_address",
    {
      title: "Add a saved address",
      description:
        "Save a new delivery address on the user's Chowdeck account from a place_id the user picked in search_address_places. The location comes only from Chowdeck's details for that place. It is not made the active delivery address unless activate is true and the user asked for that. If saved addresses may already be this place, nothing is created and they are returned as a possible_duplicate with a confirm_duplicate value to use only if the user confirms. Never call it again after an unknown outcome: check list_addresses first.",
      inputSchema: z.object({
        place_id: z
          .string()
          .trim()
          .min(1)
          .max(512)
          .regex(/^[\x21-\x7E]+$/, "Expected a place_id from search_address_places")
          .describe("place_id of the suggestion the user picked"),
        activate: z
          .boolean()
          .optional()
          .default(false)
          .describe("Make it the active delivery address. Only when the user explicitly asks."),
        confirm_duplicate: z
          .string()
          .regex(DUPLICATE_TOKEN_PATTERN, "Expected the confirm_duplicate value from a possible_duplicate result")
          .optional()
          .describe("Only after the user confirms a possible_duplicate result: the confirm_duplicate value it returned"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ place_id, activate, confirm_duplicate }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        return jsonResult(await service.create(place_id, activate, confirm_duplicate));
      } catch (error) {
        return failure("add the address", "add_address", error);
      }
    },
  );
};
