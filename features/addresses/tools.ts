import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import AddressService, { NotSignedInError } from "./service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const SESSION_UNAVAILABLE =
  "Addresses are not available on this connection: the server cannot identify individual users on this transport.";

const NOT_SIGNED_IN =
  "Failed to list addresses: not signed in to Chowdeck. Sign in, then try again.";

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
        return textResult(JSON.stringify(result));
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
};
