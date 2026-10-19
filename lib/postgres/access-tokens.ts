import { eq } from "drizzle-orm";

import { oauthAccessTokens } from "./schema";
import type { AccessTokenRecord, AccessTokenStore } from "../oauth";
import { fromEpochSeconds, toEpochSeconds, type Database } from "./database";

export class PostgresAccessTokenStore implements AccessTokenStore {
  constructor(private readonly db: Database) {}

  async get(tokenHash: string): Promise<AccessTokenRecord | undefined> {
    const [row] = await this.db
      .select()
      .from(oauthAccessTokens)
      .where(eq(oauthAccessTokens.tokenHash, tokenHash));
    if (!row) return undefined;

    return {
      userId: row.userId,
      clientId: row.clientId,
      scopes: row.scopes,
      resource: row.resource,
      expiresAt: toEpochSeconds(row.expiresAt),
    };
  }

  async save(tokenHash: string, record: AccessTokenRecord) {
    await this.db.insert(oauthAccessTokens).values({
      tokenHash,
      userId: record.userId,
      clientId: record.clientId,
      resource: record.resource,
      scopes: record.scopes,
      expiresAt: fromEpochSeconds(record.expiresAt),
    });
  }

  async revoke(tokenHash: string) {
    await this.db.delete(oauthAccessTokens).where(eq(oauthAccessTokens.tokenHash, tokenHash));
  }
}
