import { describe, expect, test } from "bun:test";

import {
  issueAuthorizationCode,
  InMemoryAuthorizationCodeStore,
  AUTHORIZATION_CODE_TTL_SECONDS,
} from "../../lib/oauth-codes";
import { hashToken } from "../../lib/oauth";

const binding = {
  scopes: [],
  userId: "user-a",
  clientId: "client-1",
  codeChallenge: "c".repeat(43),
  codeChallengeMethod: "S256" as const,
  resource: "https://chowbot.example/mcp",
  redirectUri: "https://app.example.com/callback",
};

describe("authorization codes", () => {
  test("are random, stored by hash, and expire within minutes", async () => {
    const store = new InMemoryAuthorizationCodeStore();
    const first = await issueAuthorizationCode(store, binding);
    const second = await issueAuthorizationCode(store, binding);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(AUTHORIZATION_CODE_TTL_SECONDS).toBeLessThanOrEqual(600);
    expect(await store.consume(first)).toBeUndefined();

    const record = await store.consume(hashToken(second));
    expect(record).toMatchObject(binding);
    expect(record!.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  test("can be consumed only once", async () => {
    const store = new InMemoryAuthorizationCodeStore();
    const code = await issueAuthorizationCode(store, binding);

    const [first, second] = await Promise.all([
      store.consume(hashToken(code)),
      store.consume(hashToken(code)),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await store.consume(hashToken(code))).toBeUndefined();
  });

  test("are rejected once expired", async () => {
    const store = new InMemoryAuthorizationCodeStore();
    const code = await issueAuthorizationCode(store, binding, -1);

    expect(await store.consume(hashToken(code))).toBeUndefined();
  });

  test("do not expose stored records to mutation", async () => {
    const store = new InMemoryAuthorizationCodeStore();
    const record = {
      ...binding,
      scopes: ["a"],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    };
    await store.save("hash", record);
    record.scopes.push("admin");

    expect((await store.consume("hash"))!.scopes).toEqual(["a"]);
  });
});
