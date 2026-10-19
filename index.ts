import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { logger } from "./utils/logger";
import { createServer } from "./mcp/server";

serveStdio(createServer, {
  onerror: (error) => {
    logger.error("ChowBot MCP Server error:", error);
  },
});

logger.info("ChowBot MCP Server running");
