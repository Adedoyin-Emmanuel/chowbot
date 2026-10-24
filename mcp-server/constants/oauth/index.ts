import { PORT } from "../app";

/*
 * The URL people paste into their assistant. Its path is where the MCP
 * endpoint is mounted (see mcp/http-app.ts), so a bare origin serves MCP at
 * the root of the domain; set e.g. https://example.com/mcp to use a path.
 */
export const MCP_SERVER_URL = new URL(
  process.env.MCP_SERVER_URL || `http://localhost:${PORT}`,
);
