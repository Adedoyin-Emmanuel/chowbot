import { eq, getTableColumns, sql } from "drizzle-orm";

import { oauthAuthorizationCodes } from "./schema";
import { fromEpochSeconds, toEpochSeconds, type Database } from "./database";
import type { AuthorizationCodeRecord, AuthorizationCodeStore } from "../oauth-codes";

/*
 * consume() is a single DELETE ... RETURNING: PostgreSQL row locking lets
 * exactly one concurrent caller remove the row, so a code can never be
 * redeemed twice. Expired codes are deleted too but not returned.
 */
export class PostgresAuthorizationCodeStore implements AuthorizationCodeStore {
  constructor(private readonly db: Database) {}

  async save(codeHash: string, record: AuthorizationCodeRecord) {
    await this.db.insert(oauthAuthorizationCodes).values({
      codeHash,
      userId: record.userId,
      clientId: record.clientId,
      redirectUri: record.redirectUri,
      codeChallenge: record.codeChallenge,
      codeChallengeMethod: record.codeChallengeMethod,
      resource: record.resource,
      scopes: record.scopes,
      expiresAt: fromEpochSeconds(record.expiresAt),
    });
  }

  async consume(codeHash: string): Promise<AuthorizationCodeRecord | undefined> {
    const [row] = await this.db
      .delete(oauthAuthorizationCodes)
      .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
      .returning({
        ...getTableColumns(oauthAuthorizationCodes),
        live: sql<boolean>`${oauthAuthorizationCodes.expiresAt} > now()`,
      });
    if (!row?.live) return undefined;

    return {
      userId: row.userId,
      clientId: row.clientId,
      redirectUri: row.redirectUri,
      codeChallenge: row.codeChallenge,
      codeChallengeMethod: row.codeChallengeMethod,
      resource: row.resource,
      scopes: row.scopes,
      expiresAt: toEpochSeconds(row.expiresAt),
    };
  }
}
