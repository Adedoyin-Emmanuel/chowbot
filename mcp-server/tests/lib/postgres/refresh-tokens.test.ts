import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createKeyring } from "../../../lib/encryption";
import { registerClient } from "../../../lib/oauth-clients";
import { migrate } from "../../../lib/postgres/migrations";
import { createPostgresStores } from "../../../lib/postgres";
import { issueAuthorizationCode } from "../../../lib/oauth-codes";
import { generateAccessToken, hashToken } from "../../../lib/oauth";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";
import { generateRefreshToken, type RotationDecision } from "../../../lib/oauth-refresh";

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

const RESOURCE = "https://chowbot.example/mcp";

let database: TestDatabase;
let sql: ReturnType<TestDatabase["connect"]>;
let stores: ReturnType<typeof createPostgresStores>;
let clientId: string;
let otherClientId: string;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/*
 * Signs a user in through the real authorization-code exchange so each
 * test starts from a family created exactly as /token creates one.
 */
const signIn = async (phone: string, forClient = clientId) => {
  const userId = await stores.users.findOrCreateByPhone(phone);
  const code = await issueAuthorizationCode(stores.codes, {
    userId,
    clientId: forClient,
    redirectUri: "https://app.example.com/callback",
    codeChallenge: "c".repeat(43),
    codeChallengeMethod: "S256",
    resource: RESOURCE,
    scopes: [],
  });
  const access = generateAccessToken();
  const refresh = generateRefreshToken();
  await stores.exchange.redeem(hashToken(code), (record) => ({
    result: true,
    issue: {
      tokenHash: access.tokenHash,
      refreshTokenHash: refresh.tokenHash,
      record: { ...record, expiresAt: nowSeconds() + 3600 },
    },
  }));
  return { userId, accessToken: access.token, refreshToken: refresh.token };
};

const rotation = (): RotationDecision<string> & { newRefreshToken: string; newAccessToken: string } => {
  const access = generateAccessToken();
  const refresh = generateRefreshToken();
  return {
    result: refresh.token,
    newRefreshToken: refresh.token,
    newAccessToken: access.token,
    rotate: {
      refreshTokenHash: refresh.tokenHash,
      accessToken: {
        tokenHash: access.tokenHash,
        record: { userId: "", clientId: "", scopes: [], resource: RESOURCE, expiresAt: nowSeconds() + 3600 },
      },
    },
  };
};

const rotate = (refreshToken: string) =>
  stores.refreshTokens.rotate(hashToken(refreshToken), (record) => {
    const decision = rotation();
    decision.rotate!.accessToken.record.userId = record.userId;
    decision.rotate!.accessToken.record.clientId = record.clientId;
    return decision;
  });

const familyOf = async (refreshToken: string) => {
  const [row] = await sql`
    SELECT f.id, f.revoked_at, f.revoked_reason
    FROM oauth_refresh_tokens t JOIN oauth_refresh_token_families f ON f.id = t.family_id
    WHERE t.token_hash = ${hashToken(refreshToken)}
  `;
  return row as { id: string; revoked_at: Date | null; revoked_reason: string | null };
};

describePostgres("PostgreSQL refresh tokens", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    sql = database.connect();
    await migrate(sql);
    stores = createPostgresStores(sql, createKeyring(randomBytes(32)));
    const refreshable = { redirect_uris: ["https://app.example.com/callback"], grant_types: ["authorization_code", "refresh_token"] };
    ({ client_id: clientId } = await registerClient(stores.clients, refreshable));
    ({ client_id: otherClientId } = await registerClient(stores.clients, refreshable));
  });

  afterAll(async () => {
    await database.drop();
  });

  test("the code exchange creates a family, its first token and a linked access token by hash only", async () => {
    const { userId, accessToken, refreshToken } = await signIn("08010000001");

    const [family] = await sql`SELECT * FROM oauth_refresh_token_families WHERE user_id = ${userId}`;
    expect(family).toMatchObject({ client_id: clientId, resource: RESOURCE, revoked_at: null });
    expect((family.expires_at as Date).getTime() / 1000 - nowSeconds()).toBeGreaterThan(89 * 24 * 3600);

    const [token] = await sql`SELECT * FROM oauth_refresh_tokens WHERE family_id = ${family.id}`;
    expect(token.token_hash).toBe(hashToken(refreshToken));
    expect(token.rotated_at).toBeNull();
    expect((token.expires_at as Date).getTime() / 1000 - nowSeconds()).toBeGreaterThan(29 * 24 * 3600);

    const [access] = await sql`SELECT refresh_family_id FROM oauth_access_tokens WHERE token_hash = ${hashToken(accessToken)}`;
    expect(access.refresh_family_id).toBe(family.id);

    const everything = JSON.stringify([
      ...(await sql`SELECT * FROM oauth_refresh_tokens`),
      ...(await sql`SELECT * FROM oauth_access_tokens`),
    ]);
    expect(everything).not.toContain(refreshToken);
    expect(everything).not.toContain(accessToken);
  });

  test("rotation marks the old token rotated and stores the new tokens in the same family", async () => {
    const { userId, refreshToken } = await signIn("08010000002");

    const outcome = await rotate(refreshToken);
    expect(outcome.status).toBe("rotated");
    const newRefreshToken = outcome.status === "rotated" ? outcome.result : "";

    const rows = await sql`
      SELECT token_hash, rotated_at FROM oauth_refresh_tokens
      WHERE family_id = ${(await familyOf(refreshToken)).id} ORDER BY created_at
    `;
    expect(rows).toHaveLength(2);
    expect(rows.find((r: { token_hash: string }) => r.token_hash === hashToken(refreshToken)).rotated_at).not.toBeNull();
    expect(rows.find((r: { token_hash: string }) => r.token_hash === hashToken(newRefreshToken)).rotated_at).toBeNull();
    expect((await familyOf(newRefreshToken)).id).toBe((await familyOf(refreshToken)).id);
    expect((await sql`SELECT count(*)::int AS n FROM oauth_access_tokens WHERE user_id = ${userId}`)[0].n).toBe(2);
  });

  test("allows at most one active refresh token per family", async () => {
    const { refreshToken } = await signIn("08010000003");
    const family = await familyOf(refreshToken);

    const error = await sql`
      INSERT INTO oauth_refresh_tokens (token_hash, family_id, expires_at)
      VALUES ('extra', ${family.id}, now() + interval '1 day')
    `.then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error?.message).toContain("oauth_refresh_tokens_one_active_per_family_idx");
  });

  test("concurrent rotations with the same token succeed at most once", async () => {
    const { refreshToken } = await signIn("08010000004");

    const outcomes = await Promise.all(Array.from({ length: 20 }, () => rotate(refreshToken)));

    expect(outcomes.filter((o) => o.status === "rotated").length).toBeLessThanOrEqual(1);
    const family = await familyOf(refreshToken);
    const [active] = await sql`
      SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE family_id = ${family.id} AND rotated_at IS NULL
    `;
    expect(active.n).toBeLessThanOrEqual(1);
  });

  test("reuse revokes the family and its access tokens, but nothing else", async () => {
    const victim = await signIn("08010000005");
    const sameUserOtherDevice = await signIn("08010000005");
    const sameUserOtherClient = await signIn("08010000005", otherClientId);
    const otherUser = await signIn("08010000006");

    const first = await rotate(victim.refreshToken);
    const rotatedRefresh = first.status === "rotated" ? first.result : "";
    const reused = await rotate(victim.refreshToken);

    expect(reused.status).toBe("reused");
    expect(await familyOf(victim.refreshToken)).toMatchObject({ revoked_reason: "reuse_detected" });
    expect((await rotate(rotatedRefresh)).status).toBe("invalid");
    expect(await stores.tokens.get(hashToken(victim.accessToken))).toBeUndefined();

    for (const unaffected of [sameUserOtherDevice, sameUserOtherClient, otherUser]) {
      expect((await familyOf(unaffected.refreshToken)).revoked_at).toBeNull();
      expect(await stores.tokens.get(hashToken(unaffected.accessToken))).toBeDefined();
      expect((await rotate(unaffected.refreshToken)).status).toBe("rotated");
    }
  });

  test.each([
    ["the token", "UPDATE oauth_refresh_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1"],
    [
      "the family",
      "UPDATE oauth_refresh_token_families SET expires_at = now() - interval '1 second' WHERE id = (SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = $1)",
    ],
  ])("rejects a token when %s has expired, without revoking anything", async (_, statement) => {
    const { refreshToken } = await signIn(`0801000${Math.floor(Math.random() * 9000 + 1000)}`);
    await sql.unsafe(statement, [hashToken(refreshToken)]);

    expect((await rotate(refreshToken)).status).toBe("invalid");
    expect((await familyOf(refreshToken)).revoked_at).toBeNull();
  });

  test("rejects tokens from a revoked family", async () => {
    const { refreshToken } = await signIn("08010000007");
    await sql`
      UPDATE oauth_refresh_token_families SET revoked_at = now(), revoked_reason = 'test'
      WHERE id = ${(await familyOf(refreshToken)).id}
    `;

    expect((await rotate(refreshToken)).status).toBe("invalid");
  });

  test("rolls back the whole rotation when storing the new tokens fails", async () => {
    const { refreshToken, accessToken } = await signIn("08010000008");
    const family = await familyOf(refreshToken);
    const before = await sql`SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE family_id = ${family.id}`;

    await expect(
      stores.refreshTokens.rotate(hashToken(refreshToken), (record) => {
        const decision = rotation();
        decision.rotate!.accessToken = {
          tokenHash: hashToken(accessToken),
          record: { ...decision.rotate!.accessToken.record, userId: record.userId, clientId: record.clientId },
        };
        return decision;
      }),
    ).rejects.toThrow();

    const [token] = await sql`SELECT rotated_at FROM oauth_refresh_tokens WHERE token_hash = ${hashToken(refreshToken)}`;
    expect(token.rotated_at).toBeNull();
    const after = await sql`SELECT count(*)::int AS n FROM oauth_refresh_tokens WHERE family_id = ${family.id}`;
    expect(after[0].n).toBe(before[0].n);
    expect((await rotate(refreshToken)).status).toBe("rotated");
  });

  test("a declined decision changes nothing", async () => {
    const { refreshToken } = await signIn("08010000009");

    const declined = await stores.refreshTokens.rotate(hashToken(refreshToken), () => ({ result: "no" }));

    expect(declined).toEqual({ status: "declined", result: "no" });
    expect((await rotate(refreshToken)).status).toBe("rotated");
  });

  test("unknown tokens are invalid", async () => {
    expect((await rotate(generateRefreshToken().token)).status).toBe("invalid");
  });
});
