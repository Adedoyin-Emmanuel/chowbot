import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./mcp/server";


serveStdio(createServer, {
  onerror: (error) => {
    console.error("Weather MCP Server error:", error);
  },
});

console.error("Weather MCP Server running");
