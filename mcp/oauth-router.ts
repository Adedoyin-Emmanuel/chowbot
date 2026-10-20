import express, {
  Router,
  type ErrorRequestHandler,
  type Response as ExpressResponse,
} from "express";
import type { OAuthMetadata } from "@modelcontextprotocol/server";

import { logger } from "../utils/logger";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";
import {
  registerClient,
  ClientRegistrationError,
  type ClientStore,
} from "../lib/oauth-clients";

export const TOKEN_PATH = "/token";
export const AUTHORIZE_PATH = "/authorize";
export const REGISTRATION_PATH = "/register";
export const AUTHORIZATION_SERVER_METADATA_PATH =
  "/.well-known/oauth-authorization-server";

const REGISTRATION_BODY_LIMIT = "16kb";

/*
 * grant_types, response_modes and token_endpoint_auth_methods are stated
 * explicitly because their RFC 8414 defaults would otherwise imply
 * implicit, fragment and client_secret_basic support, none of which ChowBot
 * offers.
 */
export const buildAuthorizationServerMetadata = (
  issuerUrl: URL,
): OAuthMetadata => {
  const issuer = issuerUrl.href.replace(/\/$/, "");
  return {
    issuer,
    authorization_endpoint: `${issuer}${AUTHORIZE_PATH}`,
    token_endpoint: `${issuer}${TOKEN_PATH}`,
    registration_endpoint: `${issuer}${REGISTRATION_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
};

const allowCrossOrigin = (res: ExpressResponse) =>
  res.set({
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  });

const sendRegistrationError = (
  res: ExpressResponse,
  status: number,
  error: string,
  description: string,
) => {
  allowCrossOrigin(res)
    .status(status)
    .json({ error, error_description: description });
};

const handleBodyParseError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error?.type === "entity.too.large") {
    return sendRegistrationError(
      res,
      413,
      "invalid_client_metadata",
      "Registration request is too large",
    );
  }
  sendRegistrationError(
    res,
    400,
    "invalid_client_metadata",
    "Registration request must be valid JSON",
  );
};

export const createOAuthRouter = ({
  metadata,
  clients,
}: {
  metadata: OAuthMetadata;
  clients: ClientStore;
}) => {
  const router = Router();

  router.get(AUTHORIZATION_SERVER_METADATA_PATH, (_req, res) => {
    res.set("access-control-allow-origin", "*").json(metadata);
  });

  router.options(REGISTRATION_PATH, (_req, res) => {
    allowCrossOrigin(res).sendStatus(204);
  });

  router.post(
    REGISTRATION_PATH,
    useGolbalRateLimiter,
    express.json({ limit: REGISTRATION_BODY_LIMIT }),
    async (req, res) => {
      try {
        const client = await registerClient(clients, req.body);
        allowCrossOrigin(res)
          .status(201)
          .set("cache-control", "no-store")
          .json(client);
      } catch (error) {
        if (error instanceof ClientRegistrationError) {
          return sendRegistrationError(res, 400, error.code, error.message);
        }
        logger.error(
          "Unexpected error during client registration:",
          error instanceof Error ? error.name : typeof error,
        );
        sendRegistrationError(
          res,
          500,
          "server_error",
          "Client registration failed",
        );
      }
    },
  );

  router.use(REGISTRATION_PATH, handleBodyParseError);

  return router;
};
