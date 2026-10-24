import { describe, expect, test } from "bun:test";
import { OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";

import {
  hashToken,
  issueAccessToken,
  AccessTokenVerifier,
  InMemoryAccessTokenStore,
  type AccessTokenRecord,
} from "../../lib/oauth";

const RESOURCE = new URL("https://chowbot.example/mcp");

const nowSeconds = () => Math.floor(Date.now() / 1000);

const record = (overrides: Partial<AccessTokenRecord> = {}): AccessTokenRecord => ({
  userId: "user-a",
  clientId: "client-1",
  scopes: ["mcp"],
  resource: RESOURCE.href,
  expiresAt: nowSeconds() + 3600,
  ...overrides,
});

const expectInvalidToken = async (promise: Promise<unknown>, message: string) => {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OAuthError);
  expect((error as OAuthError).code).toBe(OAuthErrorCode.InvalidToken);
  expect((error as OAuthError).message).toBe(message);
};

describe("AccessTokenVerifier", () => {
  test("returns AuthInfo with expiry, resource and user for a valid token", async () => {
    const store = new InMemoryAccessTokenStore();
    const issued = record();
    const token = await issueAccessToken(store, issued);

    const authInfo = await new AccessTokenVerifier(store, RESOURCE).verifyAccessToken(token);

    expect(authInfo).toEqual({
      token,
      clientId: "client-1",
      scopes: ["mcp"],
      expiresAt: issued.expiresAt,
      resource: RESOURCE,
      extra: { userId: "user-a" },
    });
  });

  test("rejects an unknown token", async () => {
    const verifier = new AccessTokenVerifier(new InMemoryAccessTokenStore(), RESOURCE);

    await expectInvalidToken(verifier.verifyAccessToken("not-issued"), "Invalid access token");
  });

  test("rejects an expired token", async () => {
    const store = new InMemoryAccessTokenStore();
    const token = await issueAccessToken(store, record({ expiresAt: nowSeconds() - 1 }));

    await expectInvalidToken(
      new AccessTokenVerifier(store, RESOURCE).verifyAccessToken(token),
      "Token has expired",
    );
  });

  test("rejects a token issued for another resource", async () => {
    const store = new InMemoryAccessTokenStore();
    const token = await issueAccessToken(
      store,
      record({ resource: "https://other.example/mcp" }),
    );

    await expectInvalidToken(
      new AccessTokenVerifier(store, RESOURCE).verifyAccessToken(token),
      "Token was not issued for this resource",
    );
  });

  test("rejects a revoked token", async () => {
    const store = new InMemoryAccessTokenStore();
    const token = await issueAccessToken(store, record());
    await store.revoke(hashToken(token));

    await expectInvalidToken(
      new AccessTokenVerifier(store, RESOURCE).verifyAccessToken(token),
      "Invalid access token",
    );
  });
});

describe("issueAccessToken", () => {
  test("stores only the token hash and issues unique tokens", async () => {
    const store = new InMemoryAccessTokenStore();
    const first = await issueAccessToken(store, record());
    const second = await issueAccessToken(store, record());

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(43);
    expect(await store.get(first)).toBeUndefined();
    expect(await store.get(hashToken(first))).toMatchObject({ userId: "user-a" });
  });
});
