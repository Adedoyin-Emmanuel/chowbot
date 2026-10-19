import { hashToken } from "./oauth";

export const AUTHORIZATION_CODE_TTL_SECONDS = 300;

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
