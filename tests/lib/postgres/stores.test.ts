import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";

import { hashToken, issueAccessToken } from "../../../lib/oauth";
import { createKeyring } from "../../../lib/encryption";
import { registerClient } from "../../../lib/oauth-clients";
import { issueAuthorizationCode } from "../../../lib/oauth-codes";
import { migrate } from "../../../lib/postgres/migrations";
import { createPostgresStores } from "../../../lib/postgres";
import { createTestSchema, describePostgres } from "../../helpers/postgres";

type TestSchema = Awaited<ReturnType<typeof createTestSchema>>;

const MASTER_KEY = randomBytes(32);
const nowSeconds = () => Math.floor(Date.now() / 1000);

let schema: TestSchema;
let sql: ReturnType<TestSchema["connect"]>;

const freshStores = (key = MASTER_KEY) => createPostgresStores(sql, createKeyring(key));

const createUserAndClient = async (phone: string) => {
  const stores = freshStores();
  const userId = await stores.users.findOrCreateByPhone(phone);
  const client = await registerClient(stores.clients, {
    client_name: "Test",
    redirect_uris: ["https://app.example.com/callback"],
  });
  return { stores, userId, client };
};

describePostgres("PostgreSQL stores", () => {
  beforeAll(async () => {
    schema = await createTestSchema();
    sql = schema.connect();
    await migrate(sql);
  });

  afterAll(async () => {
    await schema.drop();
  });

  test("clients persist across store and connection re-instantiation", async () => {
    const client = await registerClient(freshStores().clients, {
      client_name: 'Quoted "Client"',
      redirect_uris: ["https://claude.ai/api/mcp/auth_callback", 'com.example.app:/cb?x="1"'],
    });

    const reconnected = schema.connect();
    try {
      expect(await createPostgresStores(reconnected, createKeyring(MASTER_KEY)).clients.get(client.client_id)).toEqual(client);
    } finally {
      await reconnected.close();
    }
    expect(await freshStores().clients.get("missing")).toBeUndefined();
  });

  test("users map one verified phone to one stable ID and store only a keyed hash", async () => {
    const first = await freshStores().users.findOrCreateByPhone("08011110000");
    const again = await freshStores().users.findOrCreateByPhone("08011110000");
    const other = await freshStores().users.findOrCreateByPhone("08022220000");

    expect(again).toBe(first);
    expect(other).not.toBe(first);

    const rows = await sql`SELECT * FROM users`;
    expect(JSON.stringify(rows)).not.toContain("08011110000");
    expect(rows.every((row: { phone_hash: string }) => /^[0-9a-f]{64}$/.test(row.phone_hash))).toBe(true);
  });

  test("users are created once even under concurrent sign-ins", async () => {
    const ids = await Promise.all(
      Array.from({ length: 10 }, () => freshStores().users.findOrCreateByPhone("08033330000")),
    );

    expect(new Set(ids).size).toBe(1);
  });

  test("sessions persist encrypted and stay isolated per user", async () => {
    const alice = await freshStores().users.findOrCreateByPhone("08044440000");
    const bob = await freshStores().users.findOrCreateByPhone("08055550000");

    await freshStores().sessions.set(alice, { token: "alice-chowdeck-token", phone: "08044440000" });
    await freshStores().sessions.set(bob, { token: "bob-chowdeck-token", phone: "08055550000", guestId: "g-1" });

    expect(await freshStores().sessions.get(alice)).toEqual({ token: "alice-chowdeck-token", phone: "08044440000" });
    expect(await freshStores().sessions.get(bob)).toEqual({
      token: "bob-chowdeck-token",
      phone: "08055550000",
      guestId: "g-1",
    });

    const raw = await sql`SELECT encode(encrypted_session, 'escape') AS bytes FROM chowdeck_sessions`;
    const stored = JSON.stringify(raw);
    expect(stored).not.toContain("chowdeck-token");
    expect(stored).not.toContain("08044440000");

    await freshStores().sessions.delete(alice);
    expect(await freshStores().sessions.get(alice)).toBeUndefined();
    expect(await freshStores().sessions.get(bob)).toMatchObject({ token: "bob-chowdeck-token" });
  });

  test("a session encrypted under another key reads as signed out without leaking secrets", async () => {
    const userId = await freshStores().users.findOrCreateByPhone("08066660000");
    await freshStores().sessions.set(userId, { token: "rotated-chowdeck-token" });
    const warnings = spyOn(console, "error");

    try {
      expect(await freshStores(randomBytes(32)).sessions.get(userId)).toBeUndefined();

      const logged = warnings.mock.calls.flat().map(String).join("\n");
      expect(logged).toContain("could not be decrypted");
      expect(logged).not.toContain("rotated-chowdeck-token");
      expect(logged).not.toContain(MASTER_KEY.toString("base64"));
    } finally {
      warnings.mockRestore();
    }
  });

  test("a session row swapped onto another user fails to decrypt", async () => {
    const victim = await freshStores().users.findOrCreateByPhone("08077770000");
    const attacker = await freshStores().users.findOrCreateByPhone("08077770001");
    await freshStores().sessions.set(victim, { token: "victim-token" });
    await freshStores().sessions.set(attacker, { token: "attacker-token" });

    await sql`
      UPDATE chowdeck_sessions SET encrypted_session =
        (SELECT encrypted_session FROM chowdeck_sessions WHERE user_id = ${victim})
      WHERE user_id = ${attacker}
    `;
    const warnings = spyOn(console, "error");
    try {
      expect(await freshStores().sessions.get(attacker)).toBeUndefined();
    } finally {
      warnings.mockRestore();
    }
  });

  test("sessions reject non-user principals and unknown users", async () => {
    const stores = freshStores();

    expect(await stores.sessions.get("not-a-uuid")).toBeUndefined();
    await expect(stores.sessions.set("not-a-uuid", { token: "x" })).rejects.toThrow(
      "Chowdeck sessions can only be stored for ChowBot user IDs",
    );
    await expect(stores.sessions.set(crypto.randomUUID(), { token: "x" })).rejects.toThrow();
  });

  test("access tokens are stored only as hashes and keep their expiry", async () => {
    const { userId, client } = await createUserAndClient("08088880000");
    const expiresAt = nowSeconds() + 3600;

    const token = await issueAccessToken(freshStores().tokens, {
      userId,
      clientId: client.client_id,
      scopes: ["mcp"],
      resource: "https://chowbot.example/mcp",
      expiresAt,
    });

    expect(await freshStores().tokens.get(hashToken(token))).toEqual({
      userId,
      clientId: client.client_id,
      scopes: ["mcp"],
      resource: "https://chowbot.example/mcp",
      expiresAt,
    });
    expect(await freshStores().tokens.get(token)).toBeUndefined();
    const rows = await sql`SELECT * FROM oauth_access_tokens`;
    expect(JSON.stringify(rows)).not.toContain(token);

    await freshStores().tokens.revoke(hashToken(token));
    expect(await freshStores().tokens.get(hashToken(token))).toBeUndefined();
  });

  test("access tokens require an existing user and client", async () => {
    await expect(
      freshStores().tokens.save(hashToken("orphan"), {
        userId: crypto.randomUUID(),
        clientId: "missing-client",
        scopes: [],
        resource: "https://chowbot.example/mcp",
        expiresAt: nowSeconds() + 60,
      }),
    ).rejects.toThrow();
  });

  test("authorization codes keep their exact binding and are stored only as hashes", async () => {
    const { userId, client } = await createUserAndClient("08099990000");
    const binding = {
      userId,
      clientId: client.client_id,
      redirectUri: "https://app.example.com/callback",
      codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      codeChallengeMethod: "S256" as const,
      resource: "https://chowbot.example/mcp",
      scopes: [],
    };

    const code = await issueAuthorizationCode(freshStores().codes, binding);
    const rows = await sql`SELECT * FROM oauth_authorization_codes`;
    expect(JSON.stringify(rows)).not.toContain(code);

    const record = await freshStores().codes.consume(hashToken(code));
    expect(record).toEqual({ ...binding, expiresAt: expect.any(Number) });
    expect(record!.expiresAt - nowSeconds()).toBeGreaterThan(250);
    expect(record!.expiresAt - nowSeconds()).toBeLessThanOrEqual(300);
  });

  test("authorization codes are single-use under concurrent redemption", async () => {
    const { userId, client } = await createUserAndClient("08010100000");
    const code = await issueAuthorizationCode(freshStores().codes, {
      userId,
      clientId: client.client_id,
      redirectUri: "https://app.example.com/callback",
      codeChallenge: "c".repeat(43),
      codeChallengeMethod: "S256",
      resource: "https://chowbot.example/mcp",
      scopes: [],
    });

    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => freshStores().codes.consume(hashToken(code))),
    );

    expect(attempts.filter(Boolean)).toHaveLength(1);
    expect(await freshStores().codes.consume(hashToken(code))).toBeUndefined();
  });

  test("expired authorization codes are rejected and removed", async () => {
    const { userId, client } = await createUserAndClient("08020200000");
    const code = await issueAuthorizationCode(
      freshStores().codes,
      {
        userId,
        clientId: client.client_id,
        redirectUri: "https://app.example.com/callback",
        codeChallenge: "c".repeat(43),
        codeChallengeMethod: "S256",
        resource: "https://chowbot.example/mcp",
        scopes: [],
      },
      -1,
    );

    expect(await freshStores().codes.consume(hashToken(code))).toBeUndefined();
    const [row] = await sql`
      SELECT count(*)::int AS remaining FROM oauth_authorization_codes WHERE code_hash = ${hashToken(code)}
    `;
    expect(row.remaining).toBe(0);
  });
});
