import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { migrate, MIGRATIONS_FOLDER } from "../../../lib/postgres/migrations";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;
type Sql = ReturnType<TestDatabase["connect"]>;

let database: TestDatabase;

const AUTH_TABLES = [
  "chowdeck_sessions",
  "oauth_access_tokens",
  "oauth_authorization_codes",
  "oauth_clients",
  "oauth_refresh_token_families",
  "oauth_refresh_tokens",
  "users",
];

const publicTables = async (sql: Sql) =>
  (
    await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
  ).map((row: { table_name: string }) => row.table_name);

/*
 * Migrates a fresh database only up to the given tags, as an existing
 * deployment would be, and returns the folder to remove afterwards.
 */
const migrateUpTo = async (sql: Sql, lastTag: string) => {
  const folder = await mkdtemp(join(tmpdir(), "chowbot-migrations-"));
  const journal = await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json();
  const last = journal.entries.findIndex((entry: { tag: string }) => entry.tag === lastTag);
  journal.entries = journal.entries.slice(0, last + 1);
  for (const { tag } of journal.entries) await cp(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(folder, `${tag}.sql`));
  await Bun.write(join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  await migrate(sql, folder);
  return folder;
};

const seedAuthData = async (sql: Sql, phoneHash: string) => {
  const [user] = await sql`INSERT INTO users (phone_hash) VALUES (${phoneHash}) RETURNING id`;
  await sql`INSERT INTO chowdeck_sessions (user_id, encrypted_session) VALUES (${user.id}, ${new Uint8Array([1, 2, 3])})`;
  await sql`
    INSERT INTO oauth_clients (client_id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_id_issued_at)
    VALUES ('kept-client', ${["https://a.example/cb"]}::jsonb, ${["authorization_code"]}::jsonb, ${["code"]}::jsonb, 'none', 1)
  `;
  await sql`
    INSERT INTO oauth_access_tokens (token_hash, user_id, client_id, resource, scopes, expires_at)
    VALUES ('kept-token', ${user.id}, 'kept-client', 'https://r.example/mcp', ${[]}::jsonb, now() + interval '1 hour')
  `;
  return user.id as string;
};

const authSnapshot = async (sql: Sql) => ({
  users: await sql`SELECT id, phone_hash FROM users`,
  sessions: await sql`SELECT user_id, encrypted_session FROM chowdeck_sessions`,
  clients: await sql`SELECT client_id FROM oauth_clients`,
  tokens: await sql`SELECT token_hash, user_id FROM oauth_access_tokens`,
});

describePostgres("migrations (PostgreSQL)", () => {
  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  test("create only the authentication schema", async () => {
    const sql = database.connect();

    await migrate(sql);

    expect(await publicTables(sql)).toEqual(AUTH_TABLES);
  });

  test("are repeatable and never remove existing data", async () => {
    const sql = database.connect();
    await migrate(sql);
    await sql`
      INSERT INTO oauth_clients (client_id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_id_issued_at)
      VALUES ('kept', ${["https://a.example/cb"]}::jsonb, ${["authorization_code"]}::jsonb, ${["code"]}::jsonb, 'none', 1)
    `;

    await migrate(sql);

    const [row] = await sql`SELECT client_id FROM oauth_clients`;
    expect(row.client_id).toBe("kept");
  });

  test("upgrade an existing 0001 database without touching its data", async () => {
    const sql = database.connect();
    const folder = await migrateUpTo(sql, "0001_refresh_tokens");
    try {
      await seedAuthData(sql, "hash-kept");
      const before = await authSnapshot(sql);

      await migrate(sql);

      expect(await authSnapshot(sql)).toEqual(before);
      expect(await publicTables(sql)).toEqual(AUTH_TABLES);
      const [applied] = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      expect(applied.count).toBe(
        (await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json()).entries.length,
      );
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  /*
   * A deployment on 0008 holds order attempts, an operator and an append-only
   * recovery audit row that references a user with ON DELETE RESTRICT. The
   * upgrade drops all of it and keeps every authentication row.
   */
  test("upgrade a 0008 database holding order-workflow rows: drops them and keeps authentication data", async () => {
    const sql = database.connect();
    const folder = await migrateUpTo(sql, "0008_wallet_and_pay_for_me");
    try {
      const userId = await seedAuthData(sql, "hash-0008");
      const [operator] = await sql`INSERT INTO admin_operators (name, credential_hash) VALUES ('ops-existing', 'h') RETURNING id`;
      const [attempt] = await sql`
        INSERT INTO order_submissions (user_id, vendor_id, cart_id, fee_id, address_binding, cart_fingerprint, computed_total,
          quote_expires_at, state, chowdeck_order_id, confirmation_consumed_at, order_request_started_at,
          lock_released_at, lock_release_reason)
        VALUES (${userId}, 102555, 1, 1, 'b', 'f', 554000, now() + interval '5 minutes', 'created', 7001326, now(), now(),
          now(), 'operator_released')
        RETURNING id
      `;
      await sql`
        INSERT INTO order_submission_recoveries (submission_id, user_id, operator_id, reason_code, note, attempt_snapshot,
          lookup_outcome, duplicate_risk_acknowledged, disclosure)
        VALUES (${attempt.id}, ${userId}, ${operator.id}, 'user_reported_abandoned', 'A note long enough.', '{}'::jsonb,
          'not_applicable', true, 'x')
      `;
      const before = await authSnapshot(sql);

      await migrate(sql);

      expect(await authSnapshot(sql)).toEqual(before);
      expect(await publicTables(sql)).toEqual(AUTH_TABLES);
      const functions = await sql`SELECT proname FROM pg_proc WHERE proname = 'order_submission_recoveries_append_only'`;
      expect(functions).toHaveLength(0);
      // The audit's ON DELETE RESTRICT no longer pins the user.
      await sql`DELETE FROM users WHERE id = ${userId}`;
      expect(await sql`SELECT * FROM chowdeck_sessions`).toHaveLength(0);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
