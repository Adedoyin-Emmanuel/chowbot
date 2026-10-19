import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createKeyring } from "../../../lib/encryption";
import { registerClient } from "../../../lib/oauth-clients";
import { migrate } from "../../../lib/postgres/migrations";
import { createPostgresStores } from "../../../lib/postgres";
import { issueAuthorizationCode } from "../../../lib/oauth-codes";
import { generateAccessToken, hashToken } from "../../../lib/oauth";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

let database: TestDatabase;
let stores: ReturnType<typeof createPostgresStores>;
let userId: string;
let clientId: string;

const newCode = (ttlSeconds?: number) =>
  issueAuthorizationCode(
    stores.codes,
    {
      userId,
      clientId,
      redirectUri: "https://app.example.com/callback",
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      resource: "https://chowbot.example/mcp",
      scopes: [],
    },
    ttlSeconds,
  );

const tokenFor = (tokenHash: string) => ({
  tokenHash,
  record: {
    userId,
    clientId,
    scopes: [],
    resource: "https://chowbot.example/mcp",
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
  },
});

const countTokens = async () => {
  const [row] = await database.connect()`SELECT count(*)::int AS n FROM oauth_access_tokens`;
  return row.n as number;
};

describePostgres("PostgreSQL authorization-code exchange", () => {
  beforeAll(async () => {
    database = await createTestDatabase();
    const sql = database.connect();
    await migrate(sql);
    stores = createPostgresStores(sql, createKeyring(randomBytes(32)));
    userId = await stores.users.findOrCreateByPhone("08012345678");
    ({ client_id: clientId } = await registerClient(stores.clients, {
      redirect_uris: ["https://app.example.com/callback"],
    }));
  });

  afterAll(async () => {
    await database.drop();
  });

  test("consumes the code and stores the token in one transaction", async () => {
    const code = await newCode();
    const { tokenHash } = generateAccessToken();
    const before = await countTokens();

    const result = await stores.exchange.redeem(hashToken(code), (record) => ({
      result: record.userId,
      issue: tokenFor(tokenHash),
    }));

    expect(result).toBe(userId);
    expect(await countTokens()).toBe(before + 1);
    expect(await stores.tokens.get(tokenHash)).toMatchObject({ userId, clientId });
    expect(await stores.codes.consume(hashToken(code))).toBeUndefined();
  });

  test("lets exactly one concurrent redemption issue a token", async () => {
    const code = await newCode();
    const before = await countTokens();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        stores.exchange.redeem(hashToken(code), () => {
          const { tokenHash } = generateAccessToken();
          return { result: tokenHash, issue: tokenFor(tokenHash) };
        }),
      ),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countTokens()).toBe(before + 1);
  });

  test("rolls back the code consumption when storing the token fails", async () => {
    const code = await newCode();
    const { tokenHash: existingHash } = generateAccessToken();
    await stores.tokens.save(existingHash, tokenFor(existingHash).record);
    const before = await countTokens();

    await expect(
      stores.exchange.redeem(hashToken(code), () => ({ result: "duplicate", issue: tokenFor(existingHash) })),
    ).rejects.toThrow();
    expect(await countTokens()).toBe(before);

    const { tokenHash } = generateAccessToken();
    const retried = await stores.exchange.redeem(hashToken(code), () => ({
      result: "retried",
      issue: tokenFor(tokenHash),
    }));
    expect(retried).toBe("retried");
  });

  test("consumes the code without issuing a token when the decision rejects it", async () => {
    const code = await newCode();
    const before = await countTokens();

    const rejected = await stores.exchange.redeem(hashToken(code), () => ({ result: "rejected" }));

    expect(rejected).toBe("rejected");
    expect(await countTokens()).toBe(before);
    expect(await stores.exchange.redeem(hashToken(code), () => ({ result: "again" }))).toBeUndefined();
  });

  test("never hands an expired or unknown code to the decision", async () => {
    const expired = await newCode(-1);
    let decided = false;
    const decide = () => {
      decided = true;
      return { result: "should not happen" };
    };

    expect(await stores.exchange.redeem(hashToken(expired), decide)).toBeUndefined();
    expect(await stores.exchange.redeem(hashToken("unknown"), decide)).toBeUndefined();
    expect(decided).toBe(false);
  });
});
