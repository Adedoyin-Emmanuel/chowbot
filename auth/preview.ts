/*
 * Runs the real sign-in flow locally against a fake Chowdeck, so the pages
 * can be worked on without sending real codes. Uses the MCP server's own
 * router with in-memory stores; nothing is persisted or sent anywhere.
 *
 *   bun run dev        (rebuilds on change and serves the preview)
 *
 * Open the printed URL. Any valid Nigerian number works; the code is
 * PREVIEW_CODE (1234). 08000000000 simulates Chowdeck refusing to send a code.
 */
import { join } from "node:path";

import {
  registerClient,
  InMemoryClientStore,
} from "../mcp-server/lib/oauth-clients";
import { ChowdeckClient } from "../mcp-server/lib/client";
import { createHttpApp } from "../mcp-server/mcp/http-app";
import { InMemoryUserStore } from "../mcp-server/lib/users";
import { InMemorySessionStore } from "../mcp-server/lib/session";
import { InMemoryAccessTokenStore } from "../mcp-server/lib/oauth";
import { createAuthorizeUi } from "../mcp-server/mcp/authorize-ui";
import { InMemoryAuthorizationCodeStore } from "../mcp-server/lib/oauth-codes";

const PREVIEW_CODE = "1234";
const PORT = Number(process.env.PREVIEW_PORT || 2801);
const origin = `http://localhost:${PORT}`;

const fakeChowdeck = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const body = (await req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    await Bun.sleep(700);
    if (path === "/auth/login") {
      return body.phone === "08000000000"
        ? Response.json({ message: "Account not found" }, { status: 404 })
        : Response.json({ status: "success" });
    }
    if (path === "/auth/login/validate-otp" && body.otp === PREVIEW_CODE) {
      return Response.json({
        status: "success",
        data: { token: "preview-token" },
      });
    }
    return Response.json({ message: "Invalid OTP" }, { status: 400 });
  },
});

const clients = new InMemoryClientStore();
const client = await registerClient(clients, {
  client_name: process.env.PREVIEW_CLIENT_NAME || "Claude",
  redirect_uris: [`${origin}/preview/callback`],
});

/*
 * Production serves MCP at the root of its domain, but here "/" redirects
 * into the sign-in flow (below), so MCP sits at /mcp out of the way. The
 * sign-in pages don't depend on where MCP is mounted.
 */
const app = createHttpApp({
  serverUrl: new URL(`${origin}/mcp`),
  users: new InMemoryUserStore(),
  clients,
  sessions: new InMemorySessionStore(),
  tokens: new InMemoryAccessTokenStore(),
  codes: new InMemoryAuthorizationCodeStore(),
  chowdeck: new ChowdeckClient({
    baseUrl: fakeChowdeck.url.origin,
    timeoutMs: 5000,
  }),
  authorizeLimits: {
    otpRequestsPerIp: 1000,
    otpRequestsPerPhone: 1000,
    otpVerificationsPerIp: 1000,
  },
  authorizeUi: createAuthorizeUi(join(import.meta.dir, "dist")),
});

// Where a real client would receive the code; here it just confirms the flow.
app.get("/preview/callback", (req, res) => {
  res
    .type("text/plain")
    .send(
      `Signed in. The client would now exchange code ${req.query.code} for a token.`,
    );
});

const challenge = new Bun.CryptoHasher("sha256")
  .update("preview-verifier-".padEnd(43, "x"))
  .digest("base64url");
const startUrl = `${origin}/authorize?${new URLSearchParams({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0]!,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "preview",
})}`;

app.get("/", (_req, res) => res.redirect(startUrl));

app.listen(PORT, () => {
  console.log(`Sign-in preview: ${origin}  (code ${PREVIEW_CODE})`);
});
