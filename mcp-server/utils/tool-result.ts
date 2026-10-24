import type { CallToolResult } from "@modelcontextprotocol/server";

import { toNairaJson } from "./money";

export const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError }),
});

// A JSON result with Chowdeck's money fields shown in naira.
export const jsonResult = (value: unknown, isError = false) => textResult(toNairaJson(value), isError);
