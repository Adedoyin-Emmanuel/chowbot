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
  type RequestStateCodec,
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
import type { PaymentChannelQuery } from "../features/order-placement/channels";
import type { PaymentStartConfig } from "../features/payments/service";
import { bindSession, type SessionStore } from "../lib/session";
import {
  bindOrderSubmissions,
  type OrderSubmissionStore,
} from "../lib/order-submissions";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";
import { AccessTokenVerifier, type AccessTokenStore } from "../lib/oauth";
import {
  createInProcessCodeExchange,
  type AuthorizationCodeStore,
  type AuthorizationCodeExchange,
} from "../lib/oauth-codes";
import {
  InMemoryRefreshTokenStore,
  type RefreshTokenStore,
} from "../lib/oauth-refresh";

/*
 * exchange and refreshTokens default to in-process implementations, which
 * are only atomic within one process. The hosted server passes the
 * PostgreSQL versions from createPostgresStores, which are transactional.
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
  refreshTokens?: RefreshTokenStore;
  exchange?: AuthorizationCodeExchange;
  authorizeLimits?: Partial<AuthorizeLimits>;
  serverFactory?: (options: ServerOptions) => McpServer;
  orderSubmissions?: OrderSubmissionStore;
  requestStateCodec?: RequestStateCodec;
  paymentChannelQuery?: PaymentChannelQuery;
  paymentStartConfig?: PaymentStartConfig;
  placeOrderEnabled?: boolean;
  lifecycle?: AppLifecycle;
};

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
  refreshTokens = new InMemoryRefreshTokenStore(tokens),
  exchange = createInProcessCodeExchange(codes, tokens, refreshTokens),
  authorizeLimits,
  serverFactory = createServer,
  orderSubmissions,
  requestStateCodec,
  paymentChannelQuery,
  paymentStartConfig,
  placeOrderEnabled,
  lifecycle,
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
      return serverFactory({
        session: bindSession(sessions, userId),
        ...(orderSubmissions && {
          submissions: bindOrderSubmissions(orderSubmissions, userId),
        }),
        ...(requestStateCodec && { requestStateCodec }),
        ...(paymentChannelQuery && { paymentChannelQuery }),
        ...(paymentStartConfig && { paymentStartConfig }),
        ...(placeOrderEnabled === true && { placeOrderEnabled }),
      });
    }),
  );

  const app = express();

  /*
   * Liveness never touches the database, so a database outage does not get
   * the process restarted; readiness does, and fails while shutting down.
   * Neither reveals anything beyond ok / not ready.
   */
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

  app.all(
    serverUrl.pathname,
    useGolbalRateLimiter,
    requireBearerToken,
    (req, res) => mcpHandler(req, res),
  );

  return app;
};
