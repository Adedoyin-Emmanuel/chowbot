import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { PORT } from "./constants/app";
import { logger } from "./utils/logger";
import { createServer } from "./mcp/server";
import { useGolbalRateLimiter } from "./middlewares/rate-limiter";

const app = express();

/*
 * No session is bound over HTTP: the handler builds a fresh server per
 * request and nothing authenticates the caller, so there is no identity that
 * could safely scope Chowdeck credentials. Login tools refuse until a verified
 * identity (e.g. OAuth-backed req.auth) is in place.
 */
const mcpHandler = toNodeHandler(createMcpHandler(() => createServer()));

app.all("/mcp", useGolbalRateLimiter, (req, res) => mcpHandler(req, res));

app.listen(Number(PORT), () => {
  logger.info("ChowBot MCP Server up and running.");
});
