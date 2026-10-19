import { PORT } from "./constants/app";
import { logger } from "./utils/logger";
import { createHttpApp } from "./mcp/http-app";
import { InMemoryUserStore } from "./lib/users";
import { InMemorySessionStore } from "./lib/session";
import { InMemoryAccessTokenStore } from "./lib/oauth";
import { InMemoryClientStore } from "./lib/oauth-clients";
import { InMemoryAuthorizationCodeStore } from "./lib/oauth-codes";
import { MCP_SERVER_URL, OAUTH_ISSUER_URL } from "./constants/oauth";

const app = createHttpApp({
  serverUrl: MCP_SERVER_URL,
  issuerUrl: OAUTH_ISSUER_URL,
  users: new InMemoryUserStore(),
  clients: new InMemoryClientStore(),
  tokens: new InMemoryAccessTokenStore(),
  codes: new InMemoryAuthorizationCodeStore(),
  sessions: new InMemorySessionStore(),
});

app.listen(Number(PORT), () => {
  logger.info("ChowBot MCP Server up and running.");
});
