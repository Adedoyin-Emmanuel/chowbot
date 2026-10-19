import type { SQL } from "bun";

type Migration = { version: number; name: string; statements: string };

/*
 * Migrations are append-only: never edit or remove an applied entry, add a
 * new version instead. Each applied migration's checksum is recorded so an
 * edited migration is detected rather than silently skipped.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    statements: `
      CREATE TABLE oauth_clients (
        client_id text PRIMARY KEY,
        client_name text,
        redirect_uris jsonb NOT NULL CHECK (jsonb_typeof(redirect_uris) = 'array' AND jsonb_array_length(redirect_uris) > 0),
        grant_types jsonb NOT NULL CHECK (jsonb_typeof(grant_types) = 'array'),
        response_types jsonb NOT NULL CHECK (jsonb_typeof(response_types) = 'array'),
        token_endpoint_auth_method text NOT NULL,
        client_id_issued_at bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE users (
        id uuid PRIMARY KEY,
        phone_hash text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE chowdeck_sessions (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        encrypted_session bytea NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE oauth_authorization_codes (
        code_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        client_id text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
        redirect_uri text NOT NULL,
        code_challenge text NOT NULL,
        code_challenge_method text NOT NULL CHECK (code_challenge_method = 'S256'),
        resource text NOT NULL,
        scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX oauth_authorization_codes_expires_at_idx ON oauth_authorization_codes (expires_at);

      CREATE TABLE oauth_access_tokens (
        token_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        client_id text NOT NULL REFERENCES oauth_clients (client_id) ON DELETE CASCADE,
        resource text NOT NULL,
        scopes jsonb NOT NULL CHECK (jsonb_typeof(scopes) = 'array'),
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX oauth_access_tokens_expires_at_idx ON oauth_access_tokens (expires_at);
      CREATE INDEX oauth_access_tokens_user_id_idx ON oauth_access_tokens (user_id);
    `,
  },
];

const MIGRATION_LOCK_ID = 7_201_844_310;

const checksum = (statements: string) =>
  new Bun.CryptoHasher("sha256").update(statements).digest("hex");

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

/*
 * Runs in one transaction under an advisory lock, so concurrently starting
 * instances apply each migration exactly once and a failure leaves the
 * schema untouched. Nothing here drops or truncates existing data.
 */
export const migrate = async (sql: SQL, migrations: Migration[] = MIGRATIONS) =>
  sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = new Map<number, { name: string; checksum: string }>();
    for (const row of await tx`SELECT version, name, checksum FROM schema_migrations`) {
      applied.set(row.version, { name: row.name, checksum: row.checksum });
    }

    const appliedNow: number[] = [];
    for (const migration of [...migrations].sort((a, b) => a.version - b.version)) {
      const expected = checksum(migration.statements);
      const existing = applied.get(migration.version);
      if (existing) {
        if (existing.checksum !== expected) {
          throw new MigrationError(
            `Migration ${migration.version} (${migration.name}) has changed since it was applied`,
          );
        }
        continue;
      }
      await tx.unsafe(migration.statements).simple();
      await tx`
        INSERT INTO schema_migrations (version, name, checksum)
        VALUES (${migration.version}, ${migration.name}, ${expected})
      `;
      appliedNow.push(migration.version);
    }
    return appliedNow;
  });
