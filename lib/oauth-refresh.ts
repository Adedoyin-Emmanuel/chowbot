import type { TokenIssue } from "./oauth-codes";
import { generateAccessToken, type AccessTokenStore } from "./oauth";

/*
 * Expiration policy. Each refresh token is valid for REFRESH_TOKEN_TTL_SECONDS
 * after it is issued, and every rotation issues a fresh one, so an active
 * client stays signed in. No family outlives REFRESH_TOKEN_FAMILY_LIFETIME_SECONDS
 * from the original browser sign-in; after that the user signs in with a
 * Chowdeck OTP again.
 */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const REFRESH_TOKEN_FAMILY_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

export const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const generateRefreshToken = generateAccessToken;

export const refreshTokenExpiresAt = (familyExpiresAt: number, nowSeconds: number) =>
  Math.min(nowSeconds + REFRESH_TOKEN_TTL_SECONDS, familyExpiresAt);

export type RefreshTokenRecord = {
  familyId: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
};

export type NewRefreshFamily = {
  refreshTokenHash: string;
  accessTokenHash: string;
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
};

export type RotationIssue = { refreshTokenHash: string; accessToken: TokenIssue };

export type RotationDecision<T> = { result: T; rotate?: RotationIssue };

export type RotationOutcome<T> =
  | { status: "rotated"; result: T }
  | { status: "declined"; result: T }
  | { status: "invalid" }
  | { status: "reused"; familyId: string };

/*
 * rotate() runs as one unit of work: an unknown, expired or revoked token is
 * "invalid"; a token that was already rotated is "reused", which revokes its
 * whole family and that family's access tokens; otherwise decide() either
 * declines (nothing changes) or returns the replacement tokens, which are
 * stored while the presented token is marked rotated. A failure while
 * storing them leaves the presented token usable.
 */
export interface RefreshTokenStore {
  createFamily(family: NewRefreshFamily): Promise<void>;
  rotate<T>(
    refreshTokenHash: string,
    decide: (token: RefreshTokenRecord) => RotationDecision<T>,
  ): Promise<RotationOutcome<T>>;
}

type Family = {
  userId: string;
  clientId: string;
  resource: string;
  scopes: string[];
  expiresAt: number;
  revoked: boolean;
  accessTokenHashes: Set<string>;
};

type StoredRefreshToken = { familyId: string; expiresAt: number; rotated: boolean };

const nowSeconds = () => Math.floor(Date.now() / 1000);

/*
 * Only atomic within a single process; intended for tests and the
 * in-memory stores. Hosted deployments use the PostgreSQL store.
 */
export class InMemoryRefreshTokenStore implements RefreshTokenStore {
  private readonly families = new Map<string, Family>();
  private readonly tokens = new Map<string, StoredRefreshToken>();

  constructor(private readonly accessTokens: AccessTokenStore) {}

  async createFamily(family: NewRefreshFamily) {
    const familyId = crypto.randomUUID();
    const expiresAt = nowSeconds() + REFRESH_TOKEN_FAMILY_LIFETIME_SECONDS;
    this.families.set(familyId, {
      userId: family.userId,
      clientId: family.clientId,
      resource: family.resource,
      scopes: [...family.scopes],
      expiresAt,
      revoked: false,
      accessTokenHashes: new Set([family.accessTokenHash]),
    });
    this.tokens.set(family.refreshTokenHash, {
      familyId,
      expiresAt: refreshTokenExpiresAt(expiresAt, nowSeconds()),
      rotated: false,
    });
  }

  async rotate<T>(
    refreshTokenHash: string,
    decide: (token: RefreshTokenRecord) => RotationDecision<T>,
  ): Promise<RotationOutcome<T>> {
    const token = this.tokens.get(refreshTokenHash);
    const family = token && this.families.get(token.familyId);
    if (!token || !family || family.revoked) return { status: "invalid" };

    if (token.rotated) {
      family.revoked = true;
      await Promise.all([...family.accessTokenHashes].map((hash) => this.accessTokens.revoke(hash)));
      return { status: "reused", familyId: token.familyId };
    }

    const now = nowSeconds();
    if (token.expiresAt <= now || family.expiresAt <= now) return { status: "invalid" };

    const { result, rotate } = decide({
      familyId: token.familyId,
      userId: family.userId,
      clientId: family.clientId,
      resource: family.resource,
      scopes: [...family.scopes],
      expiresAt: token.expiresAt,
    });
    if (!rotate) return { status: "declined", result };

    token.rotated = true;
    try {
      await this.accessTokens.save(rotate.accessToken.tokenHash, rotate.accessToken.record);
    } catch (error) {
      token.rotated = false;
      throw error;
    }
    family.accessTokenHashes.add(rotate.accessToken.tokenHash);
    this.tokens.set(rotate.refreshTokenHash, {
      familyId: token.familyId,
      expiresAt: refreshTokenExpiresAt(family.expiresAt, now),
      rotated: false,
    });
    return { status: "rotated", result };
  }
}
