import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/server";

import { logger } from "../../utils/logger";
import type { UserSession } from "../../lib/session";
import { textResult } from "../../utils/tool-result";
import AuthService, { NIGERIAN_PHONE_PATTERN } from "./service";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";

const phoneSchema = z
  .string()
  .trim()
  .regex(NIGERIAN_PHONE_PATTERN, "Expected a Nigerian mobile number, e.g. 08012345678")
  .describe("Nigerian mobile number, e.g. 08012345678 or +2348012345678");

const requestLoginOtpSchema = { phone: phoneSchema };

const verifyLoginOtpSchema = {
  phone: phoneSchema,
  otp: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, "Expected the numeric code the user received")
    .describe("The one-time code the user received"),
};

const SESSION_UNAVAILABLE =
  "Login is not available on this connection: the server cannot identify individual users on this transport, so it will not store Chowdeck credentials.";

const failure = (action: string, tool: string, error: unknown) => {
  if (error instanceof ChowdeckApiError) {
    return textResult(`Failed to ${action}: ${error.message}`, true);
  }
  logger.error(
    `Unexpected error in ${tool}:`,
    error instanceof Error ? error.name : typeof error,
  );
  return textResult(`Failed to ${action}: unexpected error`, true);
};

export const registerAuthTools = (
  server: McpServer,
  session?: UserSession,
  client?: ChowdeckClient,
) => {
  const service = session && new AuthService(session, client);

  server.registerTool(
    "request_login_otp",
    {
      title: "Request Chowdeck login code",
      description:
        "Send a Chowdeck login code to the user's phone. Ask the user for the code, then call verify_login_otp.",
      inputSchema: z.object(requestLoginOtpSchema),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ phone }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.requestLoginOtp(phone);
        return textResult(
          `Login code sent to ${result.phone}. Ask the user for the code, then call verify_login_otp with the same phone number.`,
        );
      } catch (error) {
        return failure("send login code", "request_login_otp", error);
      }
    },
  );

  server.registerTool(
    "verify_login_otp",
    {
      title: "Verify Chowdeck login code",
      description:
        "Complete Chowdeck login with the code the user received. The session is kept on the server and never returned.",
      inputSchema: z.object(verifyLoginOtpSchema),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ phone, otp }) => {
      if (!service) return textResult(SESSION_UNAVAILABLE, true);
      try {
        const result = await service.verifyLoginOtp(phone, otp);
        return textResult(`Logged in to Chowdeck as ${result.phone}.`);
      } catch (error) {
        return failure("verify login code", "verify_login_otp", error);
      }
    },
  );
};
