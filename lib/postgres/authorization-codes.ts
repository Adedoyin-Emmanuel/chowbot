import type { SQL } from "bun";

import type { AuthorizationCodeRecord, AuthorizationCodeStore } from "../oauth-codes";

/*
 * consume() is a single DELETE ... RETURNING: PostgreSQL row locking lets
 * exactly one concurrent caller remove the row, so a code can never be
 * redeemed twice. Expired codes are deleted too but not returned.
 */
export class PostgresAuthorizationCodeStore implements AuthorizationCodeStore {
  constructor(private readonly sql: SQL) {}

  async save(codeHash: string, record: AuthorizationCodeRecord) {
    await this.sql`
      INSERT INTO oauth_authorization_codes (
        code_hash, user_id, client_id, redirect_uri, code_challenge,
        code_challenge_method, resource, scopes, expires_at
      ) VALUES (
        ${codeHash}, ${record.userId}, ${record.clientId}, ${record.redirectUri},
        ${record.codeChallenge}, ${record.codeChallengeMethod}, ${record.resource},
        ${record.scopes}::jsonb, to_timestamp(${record.expiresAt})
      )
    `;
  }

  async consume(codeHash: string): Promise<AuthorizationCodeRecord | undefined> {
    const [row] = await this.sql`
      DELETE FROM oauth_authorization_codes
      WHERE code_hash = ${codeHash}
      RETURNING
        user_id, client_id, redirect_uri, code_challenge, code_challenge_method,
        resource, scopes, floor(extract(epoch FROM expires_at))::float8 AS expires_at,
        expires_at > now() AS live
    `;
    if (!row?.live) return undefined;

    return {
      userId: row.user_id,
      clientId: row.client_id,
      redirectUri: row.redirect_uri,
      codeChallenge: row.code_challenge,
      codeChallengeMethod: row.code_challenge_method,
      resource: row.resource,
      scopes: row.scopes,
      expiresAt: row.expires_at,
    };
  }
}
