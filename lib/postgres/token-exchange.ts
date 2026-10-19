import { eq, getTableColumns, sql } from "drizzle-orm";

import { fromEpochSeconds, toEpochSeconds, type Database } from "./database";
import { oauthAccessTokens, oauthAuthorizationCodes } from "./schema";
import type { AuthorizationCodeExchange } from "../oauth-codes";

/*
 * The code is deleted and the token inserted in one transaction. A
 * concurrent redemption blocks on the deleted row and then finds nothing,
 * so only one exchange can succeed; if the insert fails the delete rolls
 * back and the code is still redeemable.
 */
export class PostgresCodeExchange implements AuthorizationCodeExchange {
  constructor(private readonly db: Database) {}

  redeem: AuthorizationCodeExchange["redeem"] = (codeHash, decide) =>
    this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(oauthAuthorizationCodes)
        .where(eq(oauthAuthorizationCodes.codeHash, codeHash))
        .returning({
          ...getTableColumns(oauthAuthorizationCodes),
          live: sql<boolean>`${oauthAuthorizationCodes.expiresAt} > now()`,
        });
      if (!row?.live) return undefined;

      const { result, issue } = decide({
        userId: row.userId,
        clientId: row.clientId,
        redirectUri: row.redirectUri,
        codeChallenge: row.codeChallenge,
        codeChallengeMethod: row.codeChallengeMethod,
        resource: row.resource,
        scopes: row.scopes,
        expiresAt: toEpochSeconds(row.expiresAt),
      });

      if (issue) {
        await tx.insert(oauthAccessTokens).values({
          tokenHash: issue.tokenHash,
          userId: issue.record.userId,
          clientId: issue.record.clientId,
          resource: issue.record.resource,
          scopes: issue.record.scopes,
          expiresAt: fromEpochSeconds(issue.record.expiresAt),
        });
      }
      return result;
    });
}
