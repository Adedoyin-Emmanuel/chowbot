import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";

export type ToolResult = {
  isError?: boolean;
  content: { type: string; text: string }[];
};

export const rpc = async (
  factory: () => McpServer,
  method: string,
  params: Record<string, unknown>,
) => {
  const handler = createMcpHandler(factory);
  const response = await handler.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const text = await response.text();
  await handler.close();

  const data = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(data ? data.slice("data: ".length) : text).result;
};

export const callTool = (
  factory: () => McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> => rpc(factory, "tools/call", { name, arguments: args });
