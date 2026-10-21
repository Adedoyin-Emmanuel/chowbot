import { randomBytes } from "node:crypto";

import type { OrderSubmission } from "./order-submissions";

/*
 * Operator recovery of stuck order attempts. Only an authenticated operator,
 * through the recovery CLI, can release an attempt's cart lock; the attempt's
 * state, order id, timestamps and evidence are never changed, and every
 * release appends one immutable audit row.
 */

export type RecoveryReasonCode =
  | "user_reported_no_order"
  | "user_accepts_duplicate_risk"
  | "order_not_retrievable"
  | "user_reported_abandoned"
  | "user_reported_cancelled_in_app";

/*
 * Which reasons fit which attempt. user_reported_* codes record what the
 * user said, never a Chowdeck fact.
 */
export const REASONS_FOR_UNRESOLVED: readonly RecoveryReasonCode[] = [
  "user_reported_no_order",
  "user_accepts_duplicate_risk",
];
export const REASONS_FOR_CREATED: readonly RecoveryReasonCode[] = [
  "order_not_retrievable",
  "user_reported_abandoned",
  "user_reported_cancelled_in_app",
  "user_accepts_duplicate_risk",
];

export type RecoveryLookup =
  | {
      outcome: "unpaid";
      orderStatus: string | null;
      paymentStatus: string | null;
    }
  | { outcome: "failed"; error: string }
  | { outcome: "not_applicable" };

/*
 * An attempt as the operator sees it: any user's, with the database's own
 * verdict on whether the 24-hour wait has passed. fee_id, the address
 * binding and the confirmation nonce are never loaded.
 */
export type RecoverableAttempt = OrderSubmission & {
  userId: string;
  waitElapsed: boolean;
};

export type ReleaseRequest = {
  note: string;
  disclosure: string;
  operatorId: string;
  submissionId: string;
  lookup: RecoveryLookup;
  reasonCode: RecoveryReasonCode;
  duplicateRiskAcknowledged: true;
  expectedState: OrderSubmission["state"];
};

export type ReleaseRefusal =
  | "not_found"
  | "already_released"
  | "state_changed"
  | "not_eligible"
  | "wait_not_elapsed";

export type ReleaseResult =
  | { ok: true; recoveryId: string; releasedAt: Date }
  | { ok: false; reason: ReleaseRefusal };

export interface RecoveryStore {
  release(request: ReleaseRequest): Promise<ReleaseResult>;
  getAttempt(id: string): Promise<RecoverableAttempt | undefined>;
}

export type Operator = { id: string; name: string };

export type StoredOperator = Operator & {
  credentialHash: string;
  disabledAt: Date | null;
};

export interface OperatorStore {
  /*
   * Adds the first operator without authentication, atomically: returns
   * undefined if any operator (active or disabled) already exists.
   */
  bootstrap(name: string, credentialHash: string): Promise<Operator | undefined>;
  disable(name: string): Promise<boolean>;
  find(name: string): Promise<StoredOperator | undefined>;
  add(name: string, credentialHash: string): Promise<Operator>;
}

export const OPERATOR_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export const generateOperatorCredential = () =>
  `cbop_${randomBytes(32).toString("base64url")}`;

export const hashOperatorCredential = (credential: string) =>
  Bun.password.hash(credential, { algorithm: "argon2id" });

let dummyHash: Promise<string> | undefined;

/*
 * Verifies an operator credential against its argon2id hash. An unknown or
 * disabled operator still costs one verification, so the response time does
 * not reveal which operator names exist.
 */
export const authenticateOperator = async (
  store: OperatorStore,
  name: string | undefined,
  credential: string | undefined,
): Promise<Operator | undefined> => {
  if (!name || !credential || !OPERATOR_NAME_PATTERN.test(name))
    return undefined;
  const operator = await store.find(name);
  if (!operator || operator.disabledAt) {
    dummyHash ??= hashOperatorCredential(generateOperatorCredential());
    await Bun.password.verify(credential, await dummyHash).catch(() => false);
    return undefined;
  }
  const valid = await Bun.password
    .verify(credential, operator.credentialHash)
    .catch(() => false);
  return valid ? { id: operator.id, name: operator.name } : undefined;
};
