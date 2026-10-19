import { McpServer } from "@modelcontextprotocol/server";
import { registerArithmeticTool } from "../features/arithmetic/tools";

export const createServer = () => {
  const server = new McpServer({
    name: "ChowFlow",
    version: "1.0.0",
  });

  registerArithmeticTool(server);

  return server;
};
