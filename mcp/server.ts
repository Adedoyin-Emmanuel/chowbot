import { McpServer } from "@modelcontextprotocol/server";
import type { UserSession } from "../lib/session";
import { registerAuthTools } from "../features/auth/tools";
import { registerMenuTools } from "../features/menus/tools";
import { registerArithmeticTool } from "../features/arithmetic/tools";
import { registerRestaurantTools } from "../features/restaurants/tools";

export type ServerOptions = {
  session?: UserSession;
};

export const createServer = ({ session }: ServerOptions = {}) => {
  const server = new McpServer({
    name: "ChowBot",
    version: "1.0.0",
  });

  registerArithmeticTool(server);
  registerRestaurantTools(server);
  registerMenuTools(server);
  registerAuthTools(server, session);

  return server;
};
