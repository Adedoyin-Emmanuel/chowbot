import { eq, inArray, sql } from "drizzle-orm";

import {
  oauthAccessTokens,
  oauthRefreshTokens,
  oauthRefreshTokenFamilies,
} from "./schema";
import {
  refreshTokenExpiresAt,
  REFRESH_TOKEN_FAMILY_LIFETIME_SECONDS,
  type NewRefreshFamily,
  type RefreshTokenStore,
} from "../oauth-refresh";
import { fromEpochSeconds, toEpochSeconds, type Database } from "./database";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const nowSeconds = () => Math.floor(Date.now() / 1000);

/*
 * Inserts a family and its first refresh token and returns the family ID,
 * which the caller links to the access token issued alongside. Must run
 * inside the caller's transaction so a failure discards everything together.
 */
export const insertRefreshFamily = async (
  tx: Transaction,
  family: Omit<NewRefreshFamily, "accessTokenHash">,
) => {
  const familyExpiresAt = nowSeconds() + REFRESH_TOKEN_FAMILY_LIFETIME_SECONDS;
  const [created] = await tx
    .insert(oauthRefreshTokenFamilies)
    .values({
      userId: family.userId,
      clientId: family.clientId,
      resource: family.resource,
      scopes: family.scopes,
      expiresAt: fromEpochSeconds(familyExpiresAt),
    })
    .returning({ id: oauthRefreshTokenFamilies.id });

  await tx.insert(oauthRefreshTokens).values({
    tokenHash: family.refreshTokenHash,
    familyId: created!.id,
    expiresAt: fromEpochSeconds(refreshTokenExpiresAt(familyExpiresAt, nowSeconds())),
  });
  return created!.id;
};

/*
 * Every rotation first locks the family row, so rotations within one
 * family are serialised: of two concurrent requests with the same token,
 * the second sees it already rotated and is treated as reuse. The reuse
 * revocation commits even though the request fails; a failed issuance
 * rolls back and leaves the presented token usable.
 */
export class PostgresRefreshTokenStore implements RefreshTokenStore {
  constructor(private readonly db: Database) {}

  createFamily = async (family: NewRefreshFamily) => {
    await this.db.transaction(async (tx) => {
      const familyId = await insertRefreshFamily(tx, family);
      await tx
        .update(oauthAccessTokens)
        .set({ refreshFamilyId: familyId })
        .where(eq(oauthAccessTokens.tokenHash, family.accessTokenHash));
    });
  };

  rotate: RefreshTokenStore["rotate"] = (refreshTokenHash, decide) =>
    this.db.transaction(async (tx) => {
      const [family] = await tx
        .select()
        .from(oauthRefreshTokenFamilies)
        .where(
          inArray(
            oauthRefreshTokenFamilies.id,
            tx
              .select({ id: oauthRefreshTokens.familyId })
              .from(oauthRefreshTokens)
              .where(eq(oauthRefreshTokens.tokenHash, refreshTokenHash)),
          ),
        )
        .for("update");
      if (!family || family.revokedAt) return { status: "invalid" as const };

      const [token] = await tx
        .select({
          rotatedAt: oauthRefreshTokens.rotatedAt,
          expiresAt: oauthRefreshTokens.expiresAt,
          live: sql<boolean>`${oauthRefreshTokens.expiresAt} > now() AND ${family.expiresAt} > now()`,
        })
        .from(oauthRefreshTokens)
        .where(eq(oauthRefreshTokens.tokenHash, refreshTokenHash));
      if (!token) return { status: "invalid" as const };

      if (token.rotatedAt) {
        await tx
          .update(oauthRefreshTokenFamilies)
          .set({ revokedAt: sql`now()`, revokedReason: "reuse_detected" })
          .where(eq(oauthRefreshTokenFamilies.id, family.id));
        await tx.delete(oauthAccessTokens).where(eq(oauthAccessTokens.refreshFamilyId, family.id));
        return { status: "reused" as const, familyId: family.id };
      }
      if (!token.live) return { status: "invalid" as const };

      const { result, rotate } = decide({
        familyId: family.id,
        userId: family.userId,
        clientId: family.clientId,
        resource: family.resource,
        scopes: family.scopes,
        expiresAt: toEpochSeconds(token.expiresAt),
      });
      if (!rotate) return { status: "declined" as const, result };

      await tx
        .update(oauthRefreshTokens)
        .set({ rotatedAt: sql`now()` })
        .where(eq(oauthRefreshTokens.tokenHash, refreshTokenHash));
      await tx.insert(oauthRefreshTokens).values({
        tokenHash: rotate.refreshTokenHash,
        familyId: family.id,
        expiresAt: fromEpochSeconds(
          refreshTokenExpiresAt(toEpochSeconds(family.expiresAt), nowSeconds()),
        ),
      });
      await tx.insert(oauthAccessTokens).values({
        tokenHash: rotate.accessToken.tokenHash,
        userId: rotate.accessToken.record.userId,
        clientId: rotate.accessToken.record.clientId,
        resource: rotate.accessToken.record.resource,
        scopes: rotate.accessToken.record.scopes,
        refreshFamilyId: family.id,
        expiresAt: fromEpochSeconds(rotate.accessToken.record.expiresAt),
      });
      return { status: "rotated" as const, result };
    });
}
