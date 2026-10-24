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
import type { AuthorizeUi } from "./authorize-ui";
import {
  createInProcessCodeExchange,
  type AuthorizationCodeStore,
  type AuthorizationCodeExchange,
} from "../lib/oauth-codes";
import {
  InMemoryRefreshTokenStore,
  type RefreshTokenStore,
} from "../lib/oauth-refresh";
import type { UserStore } from "../lib/users";
import { createTokenRouter } from "./token-router";
import type { ChowdeckClient } from "../lib/client";
import type { ClientStore } from "../lib/oauth-clients";
import { createServer, type ServerOptions } from "./server";
import { bindSession, type SessionStore } from "../lib/session";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";
import type { PaymentStartConfig } from "../features/payments/service";
import { AccessTokenVerifier, type AccessTokenStore } from "../lib/oauth";
import type { PaymentChannelQuery } from "../features/order-placement/channels";

/*
 * exchange and refreshTokens default to in-process implementations, which
 * are only atomic within one process. The hosted server passes the
 * PostgreSQL versions from createPostgresStores, which are transactional.
 */
export type HttpAppOptions = {
  serverUrl: URL;
  users: UserStore;
  clients: ClientStore;
  sessions: SessionStore;
  trustProxyHops?: number;
  lifecycle?: AppLifecycle;
  tokens: AccessTokenStore;
  authorizeUi?: AuthorizeUi;
  chowdeck?: ChowdeckClient;
  placeOrderEnabled?: boolean;
  codes: AuthorizationCodeStore;
  refreshTokens?: RefreshTokenStore;
  exchange?: AuthorizationCodeExchange;
  paymentStartConfig?: PaymentStartConfig;
  paymentChannelQuery?: PaymentChannelQuery;
  authorizeLimits?: Partial<AuthorizeLimits>;
  serverFactory?: (options: ServerOptions) => McpServer;
};

const UNAVAILABLE_AUTHORIZE_UI: AuthorizeUi = { shell: async () => undefined };

/*
 * Process health for probes. isShuttingDown turns readiness off and refuses
 * new requests; checkDatabase is a cheap readiness ping.
 */
export type AppLifecycle = {
  isShuttingDown: () => boolean;
  checkDatabase: () => Promise<boolean>;
};

export const LIVENESS_PATH = "/healthz";
export const READINESS_PATH = "/readyz";

type AuthenticatedRequest = { auth?: AuthInfo };

const PROTECTED_RESOURCE_ROOT_PATH = "/.well-known/oauth-protected-resource";

const sendWebResponse = async (res: ExpressResponse, response: Response) => {
  res.status(response.status);
  response.headers.forEach((value, key) => res.setHeader(key, value));
  res.send(await response.text());
};

const userIdOf = (authInfo?: AuthInfo) => {
  const userId = authInfo?.extra?.userId;
  return typeof userId === "string" && userId ? userId : undefined;
};

export const createHttpApp = ({
  serverUrl,
  users,
  clients,
  tokens,
  codes,
  sessions,
  chowdeck,
  refreshTokens = new InMemoryRefreshTokenStore(tokens),
  exchange = createInProcessCodeExchange(codes, tokens, refreshTokens),
  authorizeLimits,
  authorizeUi = UNAVAILABLE_AUTHORIZE_UI,
  serverFactory = createServer,
  paymentChannelQuery,
  paymentStartConfig,
  placeOrderEnabled,
  lifecycle,
  trustProxyHops = 0,
}: HttpAppOptions) => {
  // The server is its own authorization server, so the issuer is its origin.
  const issuerUrl = new URL(serverUrl.origin);
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
        throw new Error("Refusing to serve MCP without an authenticated user");
      }
      return serverFactory({
        session: bindSession(sessions, userId),
        ...(paymentChannelQuery && { paymentChannelQuery }),
        ...(paymentStartConfig && { paymentStartConfig }),
        ...(placeOrderEnabled === true && { placeOrderEnabled }),
      });
    }),
  );

  const app = express();
  if (trustProxyHops > 0) app.set("trust proxy", trustProxyHops);


  app.get(LIVENESS_PATH, (_req, res) => {
    res.set("cache-control", "no-store").json({ status: "ok" });
  });
  app.get(READINESS_PATH, async (_req, res) => {
    const ready =
      !lifecycle ||
      (!lifecycle.isShuttingDown() &&
        (await lifecycle.checkDatabase().catch(() => false)));
    res
      .status(ready ? 200 : 503)
      .set("cache-control", "no-store")
      .json({ status: ready ? "ready" : "not_ready" });
  });

  /*
   * Once shutdown has begun, a new request arriving on a kept-alive
   * connection is refused before it can start anything (an order request
   * included); requests already running are left to finish.
   */
  if (lifecycle) {
    app.use((_req, res, next) => {
      if (!lifecycle.isShuttingDown()) return next();
      res
        .status(503)
        .set({ connection: "close", "retry-after": "5" })
        .json({ error: "server_shutting_down" });
    });
  }

  app.use(createOAuthRouter({ metadata: authorizationServer, clients }));
  app.use(
    createAuthorizeRouter({
      resourceUrl: serverUrl,
      secureCookies: issuerUrl.protocol === "https:",
      ui: authorizeUi,
      users,
      clients,
      sessions,
      codes,
      chowdeck,
      limits: authorizeLimits,
    }),
  );
  app.use(
    createTokenRouter({
      clients,
      exchange,
      refreshTokens,
      resourceUrl: serverUrl,
    }),
  );

  app.get(
    [new URL(resourceMetadataUrl).pathname, PROTECTED_RESOURCE_ROOT_PATH],
    (_req, res) => {
      res.set("access-control-allow-origin", "*").json(resourceMetadata);
    },
  );

  // MCP lives at MCP_SERVER_URL's path: "/" for a bare origin, else e.g. "/mcp".
  app.all(
    serverUrl.pathname,
    useGolbalRateLimiter,
    requireBearerToken,
    (req, res) => mcpHandler(req, res),
  );

  return app;
};
