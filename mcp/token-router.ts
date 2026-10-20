import express, {
  Router,
  type Request,
  type ErrorRequestHandler,
  type Response as ExpressResponse,
} from "express";

import { rateLimit } from "express-rate-limit";

import { logger } from "../utils/logger";
import { TOKEN_PATH } from "./oauth-router";
import type { ClientStore } from "../lib/oauth-clients";
import {
  hashToken,
  sameResource,
  generateAccessToken,
  ACCESS_TOKEN_TTL_SECONDS,
} from "../lib/oauth";
import {
  verifyPkceS256,
  PKCE_VERIFIER_PATTERN,
  type AuthorizationCodeExchange,
} from "../lib/oauth-codes";
import {
  generateRefreshToken,
  REFRESH_TOKEN_PATTERN,
  type RefreshTokenStore,
} from "../lib/oauth-refresh";

const TOKEN_BODY_LIMIT = "8kb";
const TOKEN_REQUESTS_PER_MINUTE = 120;

type TokenErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "invalid_target"
  | "invalid_scope"
  | "unauthorized_client"
  | "unsupported_grant_type";

class TokenRequestError extends Error {
  constructor(
    readonly code: TokenErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const sendTokenResponse = (res: ExpressResponse, status: number, body: object) => {
  res
    .status(status)
    .set({
      "cache-control": "no-store",
      pragma: "no-cache",
      "access-control-allow-origin": "*",
    })
    .json(body);
};

const sendTokenError = (res: ExpressResponse, error: TokenRequestError) =>
  sendTokenResponse(res, error.status, { error: error.code, error_description: error.message });

/*
 * Parameters must appear at most once (RFC 6749 §3.2); the urlencoded
 * parser turns repeats into arrays, which are rejected here.
 */
const formParam = (req: Request, name: string) => {
  const value = (req.body as Record<string, unknown> | undefined)?.[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TokenRequestError("invalid_request", `${name} must appear exactly once`);
  }
  return value;
};

const requiredParam = (req: Request, name: string) => {
  const value = formParam(req, name);
  if (!value) throw new TokenRequestError("invalid_request", `${name} is required`);
  return value;
};

type RefreshResult =
  | { kind: "mismatch" }
  | { kind: "invalid_scope" }
  | { kind: "issued"; token: string; refreshToken: string; scopes: string[] };

const invalidRefreshToken = () =>
  new TokenRequestError(
    "invalid_grant",
    "The refresh token is invalid, expired, revoked, or was issued to another client",
  );

const tokenResponse = ({
  token,
  refreshToken,
  scopes,
}: {
  token: string;
  refreshToken?: string;
  scopes: string[];
}) => ({
  access_token: token,
  token_type: "Bearer",
  expires_in: ACCESS_TOKEN_TTL_SECONDS,
  ...(refreshToken && { refresh_token: refreshToken }),
  ...(scopes.length > 0 && { scope: scopes.join(" ") }),
});

const isSameResource = (value: string, resourceUrl: URL) => {
  try {
    return sameResource(value, resourceUrl);
  } catch {
    return false;
  }
};

const handleBodyParseError: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const tooLarge = error?.type === "entity.too.large";
  sendTokenResponse(res, tooLarge ? 413 : 400, {
    error: "invalid_request",
    error_description: tooLarge ? "Token request is too large" : "Token request body could not be parsed",
  });
};

export const createTokenRouter = ({
  clients,
  exchange,
  resourceUrl,
  refreshTokens,
}: {
  clients: ClientStore;
  resourceUrl: URL;
  exchange: AuthorizationCodeExchange;
  refreshTokens: RefreshTokenStore;
}) => {
  const router = Router();

  const refreshAccessToken = async (req: Request, clientId: string) => {
    const refreshToken = requiredParam(req, "refresh_token");
    const requestedScopes = formParam(req, "scope")?.split(" ").filter(Boolean);
    if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) throw invalidRefreshToken();

    const outcome = await refreshTokens.rotate<RefreshResult>(hashToken(refreshToken), (record) => {
      if (record.clientId !== clientId || !isSameResource(record.resource, resourceUrl)) {
        return { result: { kind: "mismatch" as const } };
      }
      if (requestedScopes?.some((scope) => !record.scopes.includes(scope))) {
        return { result: { kind: "invalid_scope" as const } };
      }

      const scopes = requestedScopes ?? record.scopes;
      const access = generateAccessToken();
      const refresh = generateRefreshToken();
      return {
        result: { kind: "issued" as const, token: access.token, refreshToken: refresh.token, scopes },
        rotate: {
          refreshTokenHash: refresh.tokenHash,
          accessToken: {
            tokenHash: access.tokenHash,
            record: {
              userId: record.userId,
              clientId: record.clientId,
              scopes,
              resource: record.resource,
              expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
            },
          },
        },
      };
    });

    if (outcome.status === "reused") {
      logger.warn("Refresh token reuse detected; revoked token family", outcome.familyId);
      throw invalidRefreshToken();
    }
    if (outcome.status === "invalid" || outcome.result.kind === "mismatch") {
      throw invalidRefreshToken();
    }
    if (outcome.result.kind === "invalid_scope") {
      throw new TokenRequestError("invalid_scope", "The requested scope exceeds the original grant");
    }
    return tokenResponse(outcome.result);
  };

  const tokenRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: TOKEN_REQUESTS_PER_MINUTE,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) =>
      sendTokenResponse(res, 429, {
        error: "invalid_request",
        error_description: "Too many token requests; try again shortly",
      }),
  });

  router.options(TOKEN_PATH, (_req, res) => {
    res
      .set({
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      })
      .sendStatus(204);
  });

  router.post(
    TOKEN_PATH,
    tokenRateLimiter,
    express.urlencoded({ extended: false, limit: TOKEN_BODY_LIMIT }),
    async (req, res) => {
      try {
        if (!req.is("application/x-www-form-urlencoded")) {
          throw new TokenRequestError(
            "invalid_request",
            "Token requests must use application/x-www-form-urlencoded",
          );
        }
        if (req.headers.authorization || formParam(req, "client_secret") !== undefined) {
          throw new TokenRequestError(
            "invalid_client",
            'Client authentication is not supported; ChowBot only registers public clients (token_endpoint_auth_method "none")',
            401,
          );
        }

        const grantType = requiredParam(req, "grant_type");
        if (grantType !== "authorization_code" && grantType !== "refresh_token") {
          throw new TokenRequestError(
            "unsupported_grant_type",
            "Only the authorization_code and refresh_token grants are supported",
          );
        }

        const client = await clients.get(requiredParam(req, "client_id"));
        if (!client) throw new TokenRequestError("invalid_client", "Unknown client", 401);
        if (
          !client.grant_types.includes(grantType) ||
          client.token_endpoint_auth_method !== "none"
        ) {
          throw new TokenRequestError(
            "unauthorized_client",
            `This client is not allowed to use the ${grantType} grant`,
          );
        }

        const resource = formParam(req, "resource");
        if (resource !== undefined && !isSameResource(resource, resourceUrl)) {
          throw new TokenRequestError("invalid_target", "The requested resource is not served by ChowBot");
        }

        if (grantType === "refresh_token") {
          return sendTokenResponse(res, 200, await refreshAccessToken(req, client.client_id));
        }

        const code = requiredParam(req, "code");
        const redirectUri = requiredParam(req, "redirect_uri");
        const codeVerifier = requiredParam(req, "code_verifier");
        if (!PKCE_VERIFIER_PATTERN.test(codeVerifier)) {
          throw new TokenRequestError("invalid_request", "code_verifier is malformed");
        }
        const issuesRefreshToken = client.grant_types.includes("refresh_token");

        const issued = await exchange.redeem(hashToken(code), (record) => {
          const bound =
            record.clientId === client.client_id &&
            record.redirectUri === redirectUri &&
            record.codeChallengeMethod === "S256" &&
            verifyPkceS256(codeVerifier, record.codeChallenge) &&
            isSameResource(record.resource, resourceUrl);
          if (!bound) return { result: undefined };

          const { token, tokenHash } = generateAccessToken();
          const refresh = issuesRefreshToken ? generateRefreshToken() : undefined;
          return {
            result: { token, refreshToken: refresh?.token, scopes: record.scopes },
            issue: {
              tokenHash,
              refreshTokenHash: refresh?.tokenHash,
              record: {
                userId: record.userId,
                clientId: record.clientId,
                scopes: record.scopes,
                resource: record.resource,
                expiresAt: Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS,
              },
            },
          };
        });

        if (!issued) {
          throw new TokenRequestError(
            "invalid_grant",
            "The authorization code is invalid, expired, already used, or does not match this request",
          );
        }

        sendTokenResponse(res, 200, tokenResponse(issued));
      } catch (error) {
        if (error instanceof TokenRequestError) return sendTokenError(res, error);
        logger.error(
          "Token exchange failed:",
          error instanceof Error ? error.name : typeof error,
        );
        sendTokenResponse(res, 500, {
          error: "server_error",
          error_description: "The token request could not be completed",
        });
      }
    },
  );

  router.use(TOKEN_PATH, handleBodyParseError);

  return router;
};
