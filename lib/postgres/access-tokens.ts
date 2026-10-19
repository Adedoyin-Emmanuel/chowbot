import type { SQL } from "bun";

import type { AccessTokenRecord, AccessTokenStore } from "../oauth";

export class PostgresAccessTokenStore implements AccessTokenStore {
  constructor(private readonly sql: SQL) {}

  async get(tokenHash: string): Promise<AccessTokenRecord | undefined> {
    const [row] = await this.sql`
      SELECT user_id, client_id, scopes, resource,
        floor(extract(epoch FROM expires_at))::float8 AS expires_at
      FROM oauth_access_tokens
      WHERE token_hash = ${tokenHash}
    `;
    if (!row) return undefined;

    return {
      userId: row.user_id,
      clientId: row.client_id,
      scopes: row.scopes,
      resource: row.resource,
      expiresAt: row.expires_at,
    };
  }

  async save(tokenHash: string, record: AccessTokenRecord) {
    await this.sql`
      INSERT INTO oauth_access_tokens (token_hash, user_id, client_id, resource, scopes, expires_at)
      VALUES (
        ${tokenHash}, ${record.userId}, ${record.clientId}, ${record.resource},
        ${record.scopes}::jsonb, to_timestamp(${record.expiresAt})
      )
    `;
  }

  async revoke(tokenHash: string) {
    await this.sql`DELETE FROM oauth_access_tokens WHERE token_hash = ${tokenHash}`;
  }
}
