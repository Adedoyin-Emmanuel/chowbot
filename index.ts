import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { logger } from "./utils/logger";
import { createServer } from "./mcp/server";
import { InMemorySessionStore, bindSession } from "./lib/session";

const sessions = new InMemorySessionStore();

/*
 * serveStdio calls the factory once per connection, and a stdio connection
 * belongs to the single local user who launched the process, so each
 * connection gets its own principal.
 */
const createConnectionServer = () =>
  createServer({ session: bindSession(sessions, crypto.randomUUID()) });

serveStdio(createConnectionServer, {
  onerror: (error) => {
    logger.error("ChowBot MCP Server error:", error);
  },
});

logger.info("ChowBot MCP Server running");
