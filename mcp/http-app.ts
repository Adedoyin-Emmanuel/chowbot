import express, {
  type RequestHandler,
  type Response as ExpressResponse,
} from "express";
import {
  type AuthInfo,
  type McpServer,
  type OAuthMetadata,
  createMcpHandler,
  verifyBearerToken,
  bearerAuthChallengeResponse,
  buildOAuthProtectedResourceMetadata,
  getOAuthProtectedResourceMetadataUrl,
} from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";

import { createServer, type ServerOptions } from "./server";
import { bindSession, type SessionStore } from "../lib/session";
import { useGolbalRateLimiter } from "../middlewares/rate-limiter";
import { AccessTokenVerifier, type AccessTokenStore } from "../lib/oauth";

export type HttpAppOptions = {
  serverUrl: URL;
  issuerUrl: URL;
  sessions: SessionStore;
  tokens: AccessTokenStore;
  serverFactory?: (options: ServerOptions) => McpServer;
};

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
  issuerUrl,
  tokens,
  sessions,
  serverFactory = createServer,
}: HttpAppOptions) => {
  /*
   * The protected-resource document only uses the issuer. The endpoints are
   * the ones the ChowBot authorization server will expose; they are required
   * by the SDK type but are not served until that milestone.
   */
  const authorizationServer: OAuthMetadata = {
    issuer: issuerUrl.href.replace(/\/$/, ""),
    authorization_endpoint: new URL("/authorize", issuerUrl).href,
    token_endpoint: new URL("/token", issuerUrl).href,
    response_types_supported: ["code"],
  };

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
