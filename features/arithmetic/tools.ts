import { z } from "zod";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";

import ArithmeticService from "./service";

type IOP = "add" | "subtract" | "multiply" | "divide";

const arithmeticOperationSchema = {
  a: z.number().min(0).describe("First number"),
  b: z.number().min(0).describe("Second number"),
  op: z
    .enum(["add", "subtract", "multiply", "divide"])
    .describe("Arithmetic operation to perform"),
};

const textResult = (text: string, isError = false): CallToolResult => ({
  content: [{ type: "text", text }],
  ...(isError && { isError }),
});

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const performArithmeticOperationTool = (
  a: number,
  b: number,
  op: IOP,
): CallToolResult => {
  try {
    let result: number;

    switch (op) {
      case "add":
        result = ArithmeticService.add(a, b);
        break;
      case "subtract":
        result = ArithmeticService.subtract(a, b);
        break;
      case "multiply":
        result = ArithmeticService.multiply(a, b);
        break;
      case "divide":
        result = ArithmeticService.divide(a, b);
        break;
    }

    return textResult(String(result));
  } catch (error) {
    return textResult(
      `Failed to perform arithmetic: ${errorMessage(error)}`,
      true,
    );
  }
};

export const registerArithmeticTool = (server: McpServer) => {
  server.registerTool("perform_calculation", {
    title: "Perform arithmetic operation",
    description: "Perform addition, subtraction, multiplication, or division",
    inputSchema: z.object(arithmeticOperationSchema),
  }, ({ a, b, op }) => performArithmeticOperationTool(a, b, op));
};
