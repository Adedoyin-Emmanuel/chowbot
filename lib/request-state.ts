import {
  createRequestStateCodec,
  type RequestStateCodec,
} from "@modelcontextprotocol/server";

export const REQUEST_STATE_TTL_SECONDS = 5 * 60;

/*
 * Integrity protection for multi-round-trip requestState, which round-trips
 * through the client and is attacker-controlled on return. The HMAC key is
 * derived from CHOWBOT_ENCRYPTION_KEY, so every server instance accepts the
 * same state, and each state is bound to the request method and the
 * authenticated user: one user's state is rejected for anyone else.
 */
export const createChowbotRequestStateCodec = (key: Uint8Array): RequestStateCodec =>
  createRequestStateCodec({
    key,
    ttlSeconds: REQUEST_STATE_TTL_SECONDS,
    bind: (ctx) =>
      `${ctx.mcpReq.method}\0${String(ctx.http?.authInfo?.extra?.userId ?? "")}`,
  });
