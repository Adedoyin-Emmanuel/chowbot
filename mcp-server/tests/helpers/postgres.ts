import { SQL } from "bun";
import { describe } from "bun:test";

import { createDatabase } from "../../lib/postgres/database";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL?.trim() || undefined;

/*
 * Integration tests only run against TEST_DATABASE_URL, which must differ
 * from DATABASE_URL so they can never touch development or production
 * data. Each test file works in its own throwaway database: drizzle-kit
 * qualifies foreign keys with "public", so a per-file schema would not
 * isolate them.
 */
if (TEST_DATABASE_URL && TEST_DATABASE_URL === process.env.DATABASE_URL?.trim()) {
  throw new Error("TEST_DATABASE_URL must point to a different database than DATABASE_URL");
}

export const describePostgres = TEST_DATABASE_URL ? describe : describe.skip;

export const createTestDatabase = async () => {
  const name = `chowbot_test_${crypto.randomUUID().replace(/-/g, "")}`;
  const admin = new SQL(TEST_DATABASE_URL!);
  await admin.unsafe(`CREATE DATABASE "${name}"`);

  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const config = { url: url.href, poolMax: 4, connectionTimeoutSeconds: 5 };
  const connections: SQL[] = [];
  const connect = () => {
    const sql = createDatabase(config);
    connections.push(sql);
    return sql;
  };

  return {
    name,
    config,
    connect,
    async drop() {
      await Promise.all(connections.map((sql) => sql.close()));
      await admin.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    },
  };
};
