import { PORT } from "../app";

export const MCP_SERVER_URL = new URL(
  process.env.MCP_SERVER_URL || `http://localhost:${PORT}/mcp`,
);

export const OAUTH_ISSUER_URL = new URL(
  process.env.OAUTH_ISSUER_URL || MCP_SERVER_URL.origin,
);
