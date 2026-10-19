import express from "express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler } from "@modelcontextprotocol/server";

import { PORT } from "./constants/app";
import { logger } from "./utils/logger";
import { createServer } from "./mcp/server";
import { useGolbalRateLimiter } from "./middlewares/rate-limiter";

const app = express();
const mcpHandler = toNodeHandler(createMcpHandler(createServer));

app.all("/mcp", useGolbalRateLimiter, (req, res) => mcpHandler(req, res));

app.listen(Number(PORT), () => {
  logger.info("ChowFlow MCP Server up and running.");
});
