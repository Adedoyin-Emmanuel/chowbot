import { McpServer } from "@modelcontextprotocol/server";

import type { UserSession } from "../lib/session";
import { registerAuthTools } from "../features/auth/tools";
import { registerMenuTools } from "../features/menus/tools";
import { registerArithmeticTool } from "../features/arithmetic/tools";
import { registerRestaurantTools } from "../features/restaurants/tools";

/*
 * Chat-based OTP login is only for the local stdio entry point. Remote
 * clients sign in through the browser /authorize flow, so the OTP never
 * passes through an AI conversation.
 */
export type ServerOptions = {
  session?: UserSession;
  enableChatLogin?: boolean;
};

export const createServer = ({
  session,
  enableChatLogin = false,
}: ServerOptions = {}) => {
  const server = new McpServer({
    name: "ChowBot",
    version: "1.0.0",
  });

  registerArithmeticTool(server);
  registerRestaurantTools(server);
  registerMenuTools(server);
  if (enableChatLogin) registerAuthTools(server, session);

  return server;
};
