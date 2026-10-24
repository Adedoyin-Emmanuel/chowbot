import { SQL } from "bun";
import { lte, sql as raw } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";

import * as schema from "./schema";

export class DatabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigError";
  }
}

export type DatabaseConfig = {
  url: string;
  poolMax: number;
  connectionTimeoutSeconds: number;
};

const DEFAULT_POOL_MAX = 10;
const DEFAULT_CONNECTION_TIMEOUT_SECONDS = 10;

const positiveInteger = (name: string, value: string | undefined, fallback: number) => {
  const raw = value?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DatabaseConfigError(`${name} must be a positive whole number, got "${value}"`);
  }
  return parsed;
};

/*
 * TLS follows the URL's sslmode parameter (Bun defaults to "disable"). Use
 * sslmode=verify-full for databases reached over a network; a database on
 * the same host over localhost or a private network may use disable.
 */
export const readDatabaseConfig = (env: Record<string, string | undefined> = process.env): DatabaseConfig => {
  const url = env.DATABASE_URL?.trim();
  if (!url) {
    throw new DatabaseConfigError("DATABASE_URL is required to start the HTTP server");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DatabaseConfigError("DATABASE_URL is not a valid URL");
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new DatabaseConfigError("DATABASE_URL must use the postgres:// or postgresql:// scheme");
  }

  return {
    url,
    poolMax: positiveInteger("DATABASE_POOL_MAX", env.DATABASE_POOL_MAX, DEFAULT_POOL_MAX),
    connectionTimeoutSeconds: positiveInteger(
      "DATABASE_CONNECTION_TIMEOUT_SECONDS",
      env.DATABASE_CONNECTION_TIMEOUT_SECONDS,
      DEFAULT_CONNECTION_TIMEOUT_SECONDS,
    ),
  };
};

export const describeDatabase = (url: string) => {
  const parsed = new URL(url);
  return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
};

export const createDatabase = (
  config: DatabaseConfig,
  options: { searchPath?: string } = {},
) =>
  new SQL(config.url, {
    max: config.poolMax,
    idleTimeout: 30,
    maxLifetime: 60 * 60,
    connectionTimeout: config.connectionTimeoutSeconds,
    ...(options.searchPath && { connection: { search_path: options.searchPath } }),
  });

/*
 * Bun opens connections lazily, so a probe query makes an unreachable or
 * misconfigured database fail at startup. The error names the host and
 * database but never the credentials in DATABASE_URL.
 */
export const connectDatabase = async (
  config: DatabaseConfig,
  options: { searchPath?: string } = {},
) => {
  const sql = createDatabase(config, options);
  try {
    await sql`SELECT 1`;
  } catch (error) {
    await sql.close({ timeout: 0 }).catch(() => {});
    const reason = error instanceof Error ? error.message.replace(config.url, "[DATABASE_URL]") : String(error);
    throw new DatabaseConfigError(
      `Could not connect to PostgreSQL at ${describeDatabase(config.url)}: ${reason}`,
    );
  }
  return sql;
};

export const createDrizzle = (sql: SQL) => drizzle({ client: sql, schema });

export type Database = ReturnType<typeof createDrizzle>;

export const toEpochSeconds = (date: Date) => Math.floor(date.getTime() / 1000);

export const fromEpochSeconds = (seconds: number) => new Date(seconds * 1000);

export const deleteExpiredRecords = async (sql: SQL) => {
  const db = createDrizzle(sql);
  const { oauthAccessTokens, oauthAuthorizationCodes, oauthRefreshTokenFamilies } = schema;
  await db.delete(oauthAuthorizationCodes).where(lte(oauthAuthorizationCodes.expiresAt, raw`now()`));
  await db.delete(oauthAccessTokens).where(lte(oauthAccessTokens.expiresAt, raw`now()`));
  await db
    .delete(oauthRefreshTokenFamilies)
    .where(lte(oauthRefreshTokenFamilies.expiresAt, raw`now()`));
};
