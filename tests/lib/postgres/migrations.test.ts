import { mkdtemp, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "bun:test";

import { migrate, MIGRATIONS_FOLDER } from "../../../lib/postgres/migrations";
import { createDrizzle } from "../../../lib/postgres/database";
import { PostgresOperatorStore } from "../../../lib/postgres/recovery";
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
      "admin_operators",
      "chowdeck_sessions",
      "oauth_access_tokens",
      "oauth_authorization_codes",
      "oauth_clients",
      "oauth_refresh_token_families",
      "oauth_refresh_tokens",
      "order_submission_recoveries",
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

  test("upgrade a 0003 database holding a created order without touching it, and enforce the payment-start marker", async () => {
    const sql = database.connect();
    const upTo0003 = await mkdtemp(join(tmpdir(), "chowbot-migrations-"));
    try {
      const tags = ["0000_initial_schema", "0001_refresh_tokens", "0002_order_submissions", "0003_order_request_marker"];
      for (const tag of tags) await cp(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(upTo0003, `${tag}.sql`));
      const journal = await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json();
      journal.entries = journal.entries.filter((entry: { tag: string }) => tags.includes(entry.tag));
      await Bun.write(join(upTo0003, "meta", "_journal.json"), JSON.stringify(journal));
      await migrate(sql, upTo0003);

      const [user] = await sql`INSERT INTO users (phone_hash) VALUES ('hash-0003') RETURNING id`;
      const [created] = await sql`
        INSERT INTO order_submissions (user_id, vendor_id, cart_id, fee_id, address_binding, cart_fingerprint, computed_total,
          quote_expires_at, state, chowdeck_order_id, confirmation_consumed_at, order_request_started_at)
        VALUES (${user.id}, 102555, 30742921, 99887766, 'binding', 'fingerprint', 554000,
          now() + interval '5 minutes', 'created', 7001326, now(), now())
        RETURNING *
      `;

      await migrate(sql);

      const [after] = await sql`SELECT * FROM order_submissions WHERE id = ${created.id}`;
      for (const [column, value] of Object.entries(created)) expect(after[column]).toEqual(value);
      expect(after.payment_start_state).toBeNull();

      const violates = async (statement: PromiseLike<unknown>) => {
        const error = await statement.then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(String((error as { message?: string } | undefined)?.message)).toContain(
          "order_submissions_payment_start_check",
        );
      };
      await violates(sql`UPDATE order_submissions SET payment_start_state = 'started' WHERE id = ${created.id}`);
      await violates(sql`UPDATE order_submissions SET payment_started_at = now(), payment_start_state = 'other' WHERE id = ${created.id}`);
      await violates(sql`
        INSERT INTO order_submissions (user_id, vendor_id, cart_id, fee_id, address_binding, cart_fingerprint, computed_total, quote_expires_at, state, payment_started_at)
        VALUES (${user.id}, 102555, 1, 1, 'b', 'f', 1, now() + interval '5 minutes', 'quoted', now())
      `);
    } finally {
      await rm(upTo0003, { recursive: true, force: true });
    }
  });

  test("upgrade a 0004 database holding locked attempts without touching them", async () => {
    const sql = database.connect();
    const upTo0004 = await mkdtemp(join(tmpdir(), "chowbot-migrations-"));
    try {
      const tags = [
        "0000_initial_schema", "0001_refresh_tokens", "0002_order_submissions", "0003_order_request_marker",
        "0004_payment_start_outcome",
      ];
      for (const tag of tags) await cp(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(upTo0004, `${tag}.sql`));
      const journal = await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json();
      journal.entries = journal.entries.filter((entry: { tag: string }) => tags.includes(entry.tag));
      await Bun.write(join(upTo0004, "meta", "_journal.json"), JSON.stringify(journal));
      await migrate(sql, upTo0004);

      const [user] = await sql`INSERT INTO users (phone_hash) VALUES ('hash-0004') RETURNING id`;
      const attempts = await sql`
        INSERT INTO order_submissions (user_id, vendor_id, cart_id, fee_id, address_binding, cart_fingerprint, computed_total,
          quote_expires_at, state, chowdeck_order_id, confirmation_consumed_at, order_request_started_at,
          payment_started_at, payment_start_state, lock_released_at, lock_release_reason)
        VALUES
          (${user.id}, 102555, 1, 1, 'b', 'f', 554000, now() + interval '5 minutes', 'created', 7001326, now(), now(), now(), 'unknown', NULL, NULL),
          (${user.id}, 102555, 2, 1, 'b', 'f', 554000, now() + interval '5 minutes', 'paid', 7001327, now(), now(), NULL, NULL, now(), 'cart_changed'),
          (${user.id}, 102555, 3, 1, 'b', 'f', 554000, now() + interval '5 minutes', 'unknown', NULL, now(), now(), NULL, NULL, NULL, NULL)
        RETURNING *
      `;

      await migrate(sql);

      for (const before of attempts) {
        const [after] = await sql`SELECT * FROM order_submissions WHERE id = ${before.id}`;
        for (const [column, value] of Object.entries(before)) expect(after[column]).toEqual(value);
      }
      expect(await sql`SELECT * FROM order_submission_recoveries`).toHaveLength(0);
      expect(await sql`SELECT * FROM admin_operators`).toHaveLength(0);
    } finally {
      await rm(upTo0004, { recursive: true, force: true });
    }
  });

  test("upgrade a 0005 database with an operator and an abandoned attempt without touching them", async () => {
    const sql = database.connect();
    const upTo0005 = await mkdtemp(join(tmpdir(), "chowbot-migrations-"));
    try {
      const tags = [
        "0000_initial_schema", "0001_refresh_tokens", "0002_order_submissions", "0003_order_request_marker",
        "0004_payment_start_outcome", "0005_operator_recovery",
      ];
      for (const tag of tags) await cp(join(MIGRATIONS_FOLDER, `${tag}.sql`), join(upTo0005, `${tag}.sql`));
      const journal = await Bun.file(join(MIGRATIONS_FOLDER, "meta", "_journal.json")).json();
      journal.entries = journal.entries.filter((entry: { tag: string }) => tags.includes(entry.tag));
      await Bun.write(join(upTo0005, "meta", "_journal.json"), JSON.stringify(journal));
      await migrate(sql, upTo0005);

      const [user] = await sql`INSERT INTO users (phone_hash) VALUES ('hash-0005') RETURNING id`;
      const [operator] = await sql`INSERT INTO admin_operators (name, credential_hash) VALUES ('ops-existing', 'h') RETURNING *`;
      const [attempt] = await sql`
        INSERT INTO order_submissions (user_id, vendor_id, cart_id, fee_id, address_binding, cart_fingerprint, computed_total,
          quote_expires_at, state, chowdeck_order_id, confirmation_consumed_at, order_request_started_at,
          lock_released_at, lock_release_reason)
        VALUES (${user.id}, 102555, 1, 1, 'b', 'f', 554000, now() + interval '5 minutes', 'created', 7001326, now(), now(),
          now(), 'operator_released')
        RETURNING *
      `;
      const [audit] = await sql`
        INSERT INTO order_submission_recoveries (submission_id, user_id, operator_id, reason_code, note, attempt_snapshot,
          lookup_outcome, duplicate_risk_acknowledged, disclosure)
        VALUES (${attempt.id}, ${user.id}, ${operator.id}, 'user_reported_abandoned', 'A note long enough.', '{}'::jsonb,
          'not_applicable', true, 'x')
        RETURNING *
      `;

      await migrate(sql);

      const [attemptAfter] = await sql`SELECT * FROM order_submissions WHERE id = ${attempt.id}`;
      for (const [column, value] of Object.entries(attempt)) expect(attemptAfter[column]).toEqual(value);
      expect(attemptAfter.paid_after_release_at).toBeNull();
      const [operatorAfter] = await sql`SELECT * FROM admin_operators WHERE id = ${operator.id}`;
      for (const [column, value] of Object.entries(operator)) expect(operatorAfter[column]).toEqual(value);
      expect(operatorAfter.bootstrap).toBe(false);
      expect((await sql`SELECT * FROM order_submission_recoveries WHERE id = ${audit.id}`)[0]).toEqual(audit);
      expect(await new PostgresOperatorStore(createDrizzle(sql)).bootstrap("ops-intruder", "h")).toBeUndefined();
    } finally {
      await rm(upTo0005, { recursive: true, force: true });
    }
  });
});

