import { afterEach, beforeEach, expect, test } from "bun:test";

import { migrate } from "../../../lib/postgres/migrations";
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
});
