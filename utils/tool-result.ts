import type { CallToolResult } from "@modelcontextprotocol/server";

export const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError }),
});
