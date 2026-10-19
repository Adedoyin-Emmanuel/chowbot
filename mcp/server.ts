import { McpServer } from "@modelcontextprotocol/server";
import { registerMenuTools } from "../features/menus/tools";
import { registerArithmeticTool } from "../features/arithmetic/tools";
import { registerRestaurantTools } from "../features/restaurants/tools";

export const createServer = () => {
  const server = new McpServer({
    name: "ChowBot",
    version: "1.0.0",
  });

  registerArithmeticTool(server);
  registerRestaurantTools(server);
  registerMenuTools(server);

  return server;
};
