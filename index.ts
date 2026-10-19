import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createServer } from "./mcp/server";
import { logger } from "./utils/logger";


serveStdio(createServer, {
  onerror: (error) => {
    logger.error("ChowFlow MCP Server error:", error);
  },
});

logger.info("ChowFlow MCP Server running");
