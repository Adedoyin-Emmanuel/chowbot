import { McpServer } from "@modelcontextprotocol/server";

import iconPath from "../assets/images/chowbot-icon.png" with { type: "file" };

import type { UserSession } from "../lib/session";
import { registerAuthTools } from "../features/auth/tools";
import { registerMenuTools } from "../features/menus/tools";
import { registerCartTools } from "../features/carts/tools";
import { registerAddressTools } from "../features/addresses/tools";
import { registerArithmeticTool } from "../features/arithmetic/tools";
import { registerRestaurantTools } from "../features/restaurants/tools";

/*
 * Inlined as a data URI so clients can show the icon over stdio too, where
 * there is no HTTP server to fetch it from.
 */
const ICON_BYTES = await Bun.file(
  new URL(iconPath, import.meta.url),
).arrayBuffer();
const SERVER_ICON = {
  src: `data:image/png;base64,${Buffer.from(ICON_BYTES).toString("base64")}`,
  mimeType: "image/png",
  sizes: ["192x192"],
};

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
    icons: [SERVER_ICON],
  });

  registerArithmeticTool(server);
  registerRestaurantTools(server, session);
  registerMenuTools(server, session);
  registerAddressTools(server, session);
  registerCartTools(server, session);

  if (enableChatLogin) registerAuthTools(server, session);

  return server;
};
