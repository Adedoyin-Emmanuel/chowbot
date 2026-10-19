import { describe, expect, test } from "bun:test";

import {
  connectDatabase,
  readDatabaseConfig,
  DatabaseConfigError,
} from "../../../lib/postgres/database";

describe("readDatabaseConfig", () => {
  test("reads the URL and pool settings", () => {
    expect(
      readDatabaseConfig({
        DATABASE_URL: "postgres://u:p@db.internal:5432/chowbot?sslmode=verify-full",
        DATABASE_POOL_MAX: "20",
        DATABASE_CONNECTION_TIMEOUT_SECONDS: "5",
      }),
    ).toEqual({
      url: "postgres://u:p@db.internal:5432/chowbot?sslmode=verify-full",
      poolMax: 20,
      connectionTimeoutSeconds: 5,
    });
  });

  test("defaults the pool settings", () => {
    expect(readDatabaseConfig({ DATABASE_URL: "postgresql://u:p@localhost/chowbot" })).toMatchObject({
      poolMax: 10,
      connectionTimeoutSeconds: 10,
    });
  });

  test.each([
    [{}, "DATABASE_URL is required to start the HTTP server"],
    [{ DATABASE_URL: "  " }, "DATABASE_URL is required to start the HTTP server"],
    [{ DATABASE_URL: "not a url" }, "DATABASE_URL is not a valid URL"],
    [{ DATABASE_URL: "mysql://u:p@localhost/chowbot" }, "DATABASE_URL must use the postgres:// or postgresql:// scheme"],
    [{ DATABASE_URL: "postgres://u:p@localhost/db", DATABASE_POOL_MAX: "0" }, "DATABASE_POOL_MAX must be a positive whole number"],
    [{ DATABASE_URL: "postgres://u:p@localhost/db", DATABASE_POOL_MAX: "ten" }, "DATABASE_POOL_MAX must be a positive whole number"],
  ])("rejects %p", (env, message) => {
    expect(() => readDatabaseConfig(env)).toThrow(DatabaseConfigError);
    expect(() => readDatabaseConfig(env)).toThrow(message);
  });
});

describe("connectDatabase", () => {
  test("fails clearly when the database is unreachable, without leaking the password", async () => {
    const config = {
      url: "postgres://chowbot:super-secret-password@127.0.0.1:1/chowbot",
      poolMax: 1,
      connectionTimeoutSeconds: 2,
    };

    const error = await connectDatabase(config).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error!.message).toStartWith("Could not connect to PostgreSQL at 127.0.0.1:1/chowbot");
    expect(error!.message).not.toContain("super-secret-password");
  });
});
