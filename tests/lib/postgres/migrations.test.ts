import { afterEach, beforeEach, expect, test } from "bun:test";

import { createTestSchema, describePostgres } from "../../helpers/postgres";
import { MIGRATIONS, MigrationError, migrate } from "../../../lib/postgres/migrations";

type TestSchema = Awaited<ReturnType<typeof createTestSchema>>;

let schema: TestSchema;

describePostgres("migrations (PostgreSQL)", () => {
  beforeEach(async () => {
    schema = await createTestSchema();
  });

  afterEach(async () => {
    await schema.drop();
  });

  test("create the schema and record each applied version", async () => {
    const sql = schema.connect();

    expect(await migrate(sql)).toEqual(MIGRATIONS.map((m) => m.version));

    const tables = await sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = ${schema.schema} ORDER BY table_name
    `;
    expect(tables.map((row: { table_name: string }) => row.table_name)).toEqual([
      "chowdeck_sessions",
      "oauth_access_tokens",
      "oauth_authorization_codes",
      "oauth_clients",
      "schema_migrations",
      "users",
    ]);
    const recorded = await sql`SELECT version, name FROM schema_migrations ORDER BY version`;
    expect(recorded).toEqual(MIGRATIONS.map(({ version, name }) => ({ version, name })));
  });

  test("are repeatable and never remove existing data", async () => {
    const sql = schema.connect();
    await migrate(sql);
    await sql`
      INSERT INTO oauth_clients (client_id, redirect_uris, grant_types, response_types, token_endpoint_auth_method, client_id_issued_at)
      VALUES ('kept', ${["https://a.example/cb"]}::jsonb, ${["authorization_code"]}::jsonb, ${["code"]}::jsonb, 'none', 1)
    `;

    expect(await migrate(sql)).toEqual([]);
    expect(await migrate(schema.connect())).toEqual([]);

    const [row] = await sql`SELECT client_id FROM oauth_clients`;
    expect(row.client_id).toBe("kept");
  });

  test("apply each migration once when instances start concurrently", async () => {
    const results = await Promise.all([
      migrate(schema.connect()),
      migrate(schema.connect()),
      migrate(schema.connect()),
    ]);

    expect(results.flat()).toEqual(MIGRATIONS.map((m) => m.version));
  });

  test("refuse to run when an applied migration has been edited", async () => {
    const sql = schema.connect();
    await migrate(sql);

    const edited = MIGRATIONS.map((m) => ({ ...m, statements: `${m.statements}\n-- edited` }));
    const error = await migrate(sql, edited).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(MigrationError);
    expect((error as Error).message).toContain("has changed since it was applied");
  });

  test("leave the schema untouched when a migration fails", async () => {
    const sql = schema.connect();
    const broken = [
      { version: 1, name: "creates_table", statements: "CREATE TABLE partial (id int)" },
      { version: 2, name: "fails", statements: "SELECT * FROM missing_table" },
    ];

    await expect(migrate(sql, broken)).rejects.toThrow();

    const [table] = await sql`SELECT to_regclass(${`${schema.schema}.partial`}) AS name`;
    expect(table.name).toBeNull();
  });
});
