import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { migrate, MIGRATIONS_FOLDER } from "../../../lib/postgres/migrations";
import { createTestDatabase, describePostgres } from "../../helpers/postgres";

type TestDatabase = Awaited<ReturnType<typeof createTestDatabase>>;

let database: TestDatabase;

describePostgres("migrations (PostgreSQL)", () => {
  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.drop();
  });

  test("create the schema", async () => {
    const sql = database.connect();

    await migrate(sql);

    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' ORDER BY table_name
    `;
    expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual([
      "chowdeck_sessions",
      "oauth_access_tokens",
      "oauth_authorization_codes",
      "oauth_clients",
      "oauth_refresh_token_families",
      "oauth_refresh_tokens",
      "order_submissions",
      "users",
    ]);
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

  /*
   * Reproduces an existing deployment: a database migrated only through
   * 0001 and holding real-looking rows is then upgraded to the current
   * migrations. 0002 must only add its table.
   */
  test("upgrade an existing 0001 database without touching its data", async () => {
    const sql = database.connect();
    const upTo0001 = await mkdtemp(join(tmpdir(), "chowbot-migrations-"));
    try {
      await cp(join(MIGRATIONS_FOLDER, "0000_initial_schema.sql"), join(upTo0001, "0000_initial_schema.sql"));
      await cp(join(MIGRATIONS_FOLDER, "0001_refresh_tokens.sql"), join(upTo0001, "0001_refresh_tokens.sql"));
      const journal = await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json();
      journal.entries = journal.entries.filter((entry: { tag: string }) =>
        ["0000_initial_schema", "0001_refresh_tokens"].includes(entry.tag),
      );
      await Bun.write(join(upTo0001, "meta", "_journal.json"), JSON.stringify(journal));
      await migrate(sql, upTo0001);

      const [user] = await sql`INSERT INTO users (phone_hash) VALUES ('hash-kept') RETURNING id`;
      await sql`INSERT INTO chowdeck_sessions (user_id, encrypted_session) VALUES (${user.id}, ${new Uint8Array([1, 2, 3])})`;
      await sql`
        INSERT INTO oauth_clients (client_id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_id_issued_at)
        VALUES ('kept-client', ${["https://a.example/cb"]}::jsonb, ${["authorization_code"]}::jsonb, ${["code"]}::jsonb, 'none', 1)
      `;
      await sql`
        INSERT INTO oauth_access_tokens (token_hash, user_id, client_id, resource, scopes, expires_at)
        VALUES ('kept-token', ${user.id}, 'kept-client', 'https://r.example/mcp', ${[]}::jsonb, now() + interval '1 hour')
      `;
      const snapshot = async () => ({
        users: await sql`SELECT id, phone_hash FROM users`,
        sessions: await sql`SELECT user_id, encrypted_session FROM chowdeck_sessions`,
        clients: await sql`SELECT client_id FROM oauth_clients`,
        tokens: await sql`SELECT token_hash, user_id FROM oauth_access_tokens`,
      });
      const before = await snapshot();

      await migrate(sql);

      expect(await snapshot()).toEqual(before);
      const [{ count }] = await sql`SELECT count(*)::int AS count FROM order_submissions`;
      expect(count).toBe(0);
      const applied = await sql`SELECT count(*)::int AS count FROM drizzle.__drizzle_migrations`;
      expect(applied[0].count).toBe(
        (await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json()).entries.length,
      );
    } finally {
      await rm(upTo0001, { recursive: true, force: true });
    }
  });

  test("upgrade a 0002 database holding an orderable quote without touching it", async () => {
    const sql = database.connect();
    const upTo0002 = await mkdtemp(join(tmpdir(), "chowbot-migrations-"));
    try {
      const tags = ["0000_initial_schema", "0001_refresh_tokens", "0002_order_submissions"];
      for (const tag of tags) await cp(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(upTo0002, `${tag}.sql`));
      const journal = await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json();
      journal.entries = journal.entries.filter((entry: { tag: string }) => tags.includes(entry.tag));
      await Bun.write(join(upTo0002, "meta", "_journal.json"), JSON.stringify(journal));
      await migrate(sql, upTo0002);

      const [user] = await sql`INSERT INTO users (phone_hash) VALUES ('hash-0002') RETURNING id`;
      const [quote] = await sql`
        INSERT INTO order_submissions (user_id, vendor_id, cart_id, fee_id, address_binding, cart_fingerprint, computed_total, quote_expires_at, state)
        VALUES (${user.id}, 102555, 30742921, 99887766, 'binding', 'fingerprint', 554000, now() + interval '5 minutes', 'quoted')
        RETURNING *
      `;

      await migrate(sql);

      const [after] = await sql`SELECT * FROM order_submissions WHERE id = ${quote.id}`;
      for (const [column, value] of Object.entries(quote)) expect(after[column]).toEqual(value);
      expect(after.order_request_started_at).toBeNull();
      expect(after.evidence_payment_status).toBeNull();
    } finally {
      await rm(upTo0002, { recursive: true, force: true });
    }
  });
});
