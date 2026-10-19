import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
} from "@modelcontextprotocol/server";

export type AccessTokenRecord = {
  userId: string;
  clientId: string;
  scopes: string[];
  resource: string;
  expiresAt: number;
};

/*
 * Keyed by a SHA-256 hash of the access token so stores never hold usable
 * bearer tokens. expiresAt is in seconds since the epoch, matching AuthInfo.
 */
export interface AccessTokenStore {
  get(tokenHash: string): Promise<AccessTokenRecord | undefined>;
  save(tokenHash: string, record: AccessTokenRecord): Promise<void>;
  revoke(tokenHash: string): Promise<void>;
}

export class InMemoryAccessTokenStore implements AccessTokenStore {
  private readonly tokens = new Map<string, AccessTokenRecord>();

  async get(tokenHash: string) {
    const record = this.tokens.get(tokenHash);
    return record && { ...record, scopes: [...record.scopes] };
  }

  async save(tokenHash: string, record: AccessTokenRecord) {
    this.tokens.set(tokenHash, { ...record, scopes: [...record.scopes] });
  }

  async revoke(tokenHash: string) {
    this.tokens.delete(tokenHash);
  }
}

export const hashToken = (token: string) =>
  new Bun.CryptoHasher("sha256").update(token).digest("hex");

export const issueAccessToken = async (
  store: AccessTokenStore,
  record: AccessTokenRecord,
) => {
  const token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
  await store.save(hashToken(token), record);
  return token;
};

const sameResource = (a: string, b: URL) => {
  const normalise = (value: string) => {
    const url = new URL(value);
    url.hash = "";
    return url.href.replace(/\/$/, "");
  };
  return normalise(a) === normalise(b.href);
};

export class AccessTokenVerifier implements OAuthTokenVerifier {
  constructor(
    private readonly store: AccessTokenStore,
    private readonly resource: URL,
  ) {}

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = await this.store.get(hashToken(token));

    if (!record) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid access token");
    }
    if (record.expiresAt <= Date.now() / 1000) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, "Token has expired");
    }
    if (!sameResource(record.resource, this.resource)) {
      throw new OAuthError(
        OAuthErrorCode.InvalidToken,
        "Token was not issued for this resource",
      );
    }

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
      extra: { userId: record.userId },
    };
  }
}
