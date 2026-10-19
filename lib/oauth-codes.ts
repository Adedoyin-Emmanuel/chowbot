import { timingSafeEqual } from "node:crypto";

import { hashToken, type AccessTokenRecord, type AccessTokenStore } from "./oauth";

export const AUTHORIZATION_CODE_TTL_SECONDS = 300;

/*
 * RFC 7636 §4.1: 43-128 characters from the unreserved set. Checked before
 * a code is touched so a malformed request never consumes it.
 */
export const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

export const pkceS256Challenge = (verifier: string) =>
  new Bun.CryptoHasher("sha256").update(verifier).digest("base64url");

export const verifyPkceS256 = (verifier: string, challenge: string) => {
  const expected = Buffer.from(pkceS256Challenge(verifier));
  const actual = Buffer.from(challenge);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export type AuthorizationCodeRecord = {
  userId: string;
  scopes: string[];
  clientId: string;
  resource: string;
  expiresAt: number;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
};

/*
 * Codes are stored by hash. consume() must return and remove the record in
 * one step, so a code can be redeemed at most once even under concurrent
 * token requests; persistent implementations need an atomic delete-returning.
 */
export interface AuthorizationCodeStore {
  save(codeHash: string, record: AuthorizationCodeRecord): Promise<void>;
  consume(codeHash: string): Promise<AuthorizationCodeRecord | undefined>;
}

const copyRecord = (record: AuthorizationCodeRecord) => ({
  ...record,
  scopes: [...record.scopes],
});

export class InMemoryAuthorizationCodeStore implements AuthorizationCodeStore {
  private readonly codes = new Map<string, AuthorizationCodeRecord>();

  async save(codeHash: string, record: AuthorizationCodeRecord) {
    this.codes.set(codeHash, copyRecord(record));
  }

  async consume(codeHash: string) {
    const record = this.codes.get(codeHash);
    this.codes.delete(codeHash);
    if (!record || record.expiresAt <= Date.now() / 1000) return undefined;
    return copyRecord(record);
  }
}

export type TokenIssue = { tokenHash: string; record: AccessTokenRecord };

export type ExchangeDecision<T> = { result: T; issue?: TokenIssue };

/*
 * Redeems a code and stores the resulting access token as one unit of work.
 * decide() inspects the consumed code: returning an issue stores that token,
 * returning none still leaves the code consumed. If storing the token fails
 * the code is restored, so a failed exchange can be retried. Resolves to
 * undefined when the code is unknown, expired or already redeemed.
 */
export interface AuthorizationCodeExchange {
  redeem<T>(
    codeHash: string,
    decide: (code: AuthorizationCodeRecord) => ExchangeDecision<T>,
  ): Promise<T | undefined>;
}

/*
 * Only atomic within a single process; intended for the in-memory stores.
 * Hosted deployments use the PostgreSQL exchange, which runs in a
 * database transaction.
 */
export const createInProcessCodeExchange = (
  codes: AuthorizationCodeStore,
  tokens: AccessTokenStore,
): AuthorizationCodeExchange => ({
  async redeem(codeHash, decide) {
    const code = await codes.consume(codeHash);
    if (!code) return undefined;

    const { result, issue } = decide(code);
    if (issue) {
      try {
        await tokens.save(issue.tokenHash, issue.record);
      } catch (error) {
        await codes.save(codeHash, code);
        throw error;
      }
    }
    return result;
  },
});

export const issueAuthorizationCode = async (
  store: AuthorizationCodeStore,
  record: Omit<AuthorizationCodeRecord, "expiresAt">,
  ttlSeconds = AUTHORIZATION_CODE_TTL_SECONDS,
) => {
  const code = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
    "base64url",
  );
  await store.save(hashToken(code), {
    ...record,
    expiresAt: Math.floor(Date.now() / 1000) + ttlSeconds,
  });
  return code;
};
