import express, {
  type RequestHandler,
  type Response as ExpressResponse,
} from "express";
import {
  type AuthInfo,
  type McpServer,
  createMcpHandler,
  verifyBearerToken,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

import {
  createOAuthRouter,
  buildAuthorizationServerMetadata,
} from "./oauth-router";
import {
  createAuthorizeRouter,
  type AuthorizeLimits,
} from "./authorize-router";
import type { UserStore } from "../lib/users";
import { createTokenRouter } from "./token-router";
import type { ChowdeckClient } from "../lib/client";
import type { ClientStore } from "../lib/oauth-clients";
import { createServer, type ServerOptions } from "./server";
import { bindSession, type SessionStore } from "../lib/session";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";
import { AccessTokenVerifier, type AccessTokenStore } from "../lib/oauth";
import {
  createInProcessCodeExchange,
  type AuthorizationCodeStore,
  type AuthorizationCodeExchange,
} from "../lib/oauth-codes";

/*
 * exchange defaults to an in-process composition of codes and tokens, which
 * is only atomic within one process. The hosted server passes the
 * PostgreSQL exchange from createPostgresStores, which is transactional.
 */
export type HttpAppOptions = {
  serverUrl: URL;
  issuerUrl: URL;
  users: UserStore;
  clients: ClientStore;
  sessions: SessionStore;
  tokens: AccessTokenStore;
  chowdeck?: ChowdeckClient;
  codes: AuthorizationCodeStore;
  exchange?: AuthorizationCodeExchange;
  authorizeLimits?: Partial<AuthorizeLimits>;
  serverFactory?: (options: ServerOptions) => McpServer;
};

type AuthenticatedRequest = { auth?: AuthInfo };

const PROTECTED_RESOURCE_ROOT_PATH = "/.well-known/oauth-protected-resource";

const sendWebResponse = async (res: ExpressResponse, response: Response) => {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await response.text());
};

/*
 * ChowBot is its own authorization server and serves the OAuth endpoints
 * from this app, so the issuer must be this server's origin with no path.
 */
export const assertIssuerHostedBy = (issuerUrl: URL, serverUrl: URL) => {
  if (
    issuerUrl.origin !== serverUrl.origin ||
    issuerUrl.pathname !== "/" ||
    issuerUrl.search ||
    issuerUrl.hash
  ) {
    throw new Error(
      `OAUTH_ISSUER_URL must be the MCP server origin (${serverUrl.origin}), got "${issuerUrl.href}"`,
    );
  }
};

const userIdOf = (authInfo?: AuthInfo) => {
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" && userId ? userId : undefined;
};

export const createHttpApp = ({
  serverUrl,
  issuerUrl,
  users,
  clients,
  tokens,
  codes,
  sessions,
  chowdeck,
  exchange = createInProcessCodeExchange(codes, tokens),
  authorizeLimits,
  serverFactory = createServer,
}: HttpAppOptions) => {
  assertIssuerHostedBy(issuerUrl, serverUrl);

  const authorizationServer = buildAuthorizationServerMetadata(issuerUrl);
  const resourceMetadata = buildOAuthProtectedResourceMetadata({
    oauthMetadata: authorizationServer,
    resourceServerUrl: serverUrl,
    resourceName: "ChowBot",
  });
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(serverUrl);
  const verifier = new AccessTokenVerifier(tokens, serverUrl);

  const requireBearerToken: RequestHandler = async (req, res, next) => {
    try {
      (req as AuthenticatedRequest).auth = await verifyBearerToken(
        req.headers.authorization,
        { verifier, expectedResource: serverUrl, resourceMetadataUrl },
      );
      next();
    } catch (error) {
      await sendWebResponse(
        res,
        bearerAuthChallengeResponse(error, { resourceMetadataUrl }),
      );
    }
  };

  const mcpHandler = toNodeHandler(
    createMcpHandler(({ authInfo }) => {
      const userId = userIdOf(authInfo);
      if (!userId) {
        throw new Error("Refusing to serve /mcp without an authenticated user");
      }
      return serverFactory({ session: bindSession(sessions, userId) });
    }),
  );

  const app = express();

  app.use(createOAuthRouter({ metadata: authorizationServer, clients }));
  app.use(
    createAuthorizeRouter({
      resourceUrl: serverUrl,
      secureCookies: issuerUrl.protocol === "https:",
      users,
      clients,
      sessions,
      codes,
      chowdeck,
      limits: authorizeLimits,
    }),
  );
  app.use(createTokenRouter({ clients, exchange, resourceUrl: serverUrl }));

  app.get(
    [new URL(resourceMetadataUrl).pathname, PROTECTED_RESOURCE_ROOT_PATH],
    (_req, res) => {
      res.set("access-control-allow-origin", "*").json(resourceMetadata);
    },
  );

  app.all(
    serverUrl.pathname,
    useGolbalRateLimiter,
    requireBearerToken,
    (req, res) => mcpHandler(req, res),
  );

  return app;
};
