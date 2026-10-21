/*
 * Durable records of orderable checkout quotes and their order submissions.
 * The PostgreSQL store is the only implementation: duplicate protection must
 * survive restarts and hold across server instances, so there is no
 * in-memory variant and stdio gets no store.
 */

export type OrderSubmissionState =
  | "quoted"
  | "confirmation_pending"
  | "submitting"
  | "created"
  | "unknown"
  | "failed"
  | "paid"
  | "released";

export type GateFailure = "gate_rejected" | "gate_uncertain";

/*
 * What a caller may learn about a record. fee_id, the address binding and
 * the nonce hash never leave the store.
 */
export type OrderSubmission = {
  id: string;
  cartId: number;
  createdAt: Date;
  updatedAt: Date;
  vendorId: number;
  quoteExpiresAt: Date;
  computedTotal: number;
  claimedAt: Date | null;
  cartFingerprint: string;
  resolution: string | null;
  state: OrderSubmissionState;
  failureReason: string | null;
  chowdeckOrderId: number | null;
  paymentMethodId: number | null;
  paymentChannelName: string | null;
  orderRequestStartedAt: Date | null;
};

/*
 * Authoritative evidence read from Chowdeck's order detail or timeline.
 */
export type OrderEvidence = {
  orderStatus: string | null;
  paymentStatus: string | null;
};

export type LinkResult = "linked" | "not_linkable" | "order_already_linked";

export type NewQuote = {
  feeId: number;
  cartId: number;
  vendorId: number;
  addressId: number;
  computedTotal: number;
  cartFingerprint: string;
};

export type ConfirmationRequest = {
  nonceHash: string;
  ttlSeconds: number;
  paymentMethodId: number;
  paymentChannelName: string;
};

export type ClaimRefusal =
  | "not_found"
  | "not_confirmable"
  | "confirmation_invalid"
  | "expired"
  | "address_changed"
  | "cart_changed"
  | "cart_locked";

export type ClaimResult =
  | { ok: true; submission: OrderSubmission; feeId: number }
  | { ok: false; reason: ClaimRefusal; lockedBy?: OrderSubmissionState };

export type SubmissionOutcome =
  | { kind: "created"; chowdeckOrderId: number }
  | { kind: "rejected" }
  | { kind: "unknown" };

export interface OrderSubmissionStore {
  createQuote(
    userId: string,
    quote: NewQuote,
  ): Promise<{ id: string; quoteExpiresAt: Date }>;
  get(userId: string, id: string): Promise<OrderSubmission | undefined>;
  issueConfirmation(
    userId: string,
    id: string,
    request: ConfirmationRequest,
  ): Promise<boolean>;
  claim(
    userId: string,
    id: string,
    check: { nonceHash: string; addressId: number; cartFingerprint: string },
  ): Promise<ClaimResult>;
  recordGateFailure(
    userId: string,
    id: string,
    reason: GateFailure,
  ): Promise<boolean>;
  markOrderRequestStarted(userId: string, id: string): Promise<boolean>;
  recoverUnsent(userId: string, cartId: number): Promise<number>;
  recordOutcome(
    userId: string,
    id: string,
    outcome: SubmissionOutcome,
  ): Promise<boolean>;
  recordPaid(
    userId: string,
    id: string,
    evidence: OrderEvidence,
  ): Promise<boolean>;
  linkOrder(
    userId: string,
    id: string,
    chowdeckOrderId: number,
    evidence: OrderEvidence,
  ): Promise<LinkResult>;
  listOpen(userId: string, vendorId: number): Promise<OrderSubmission[]>;
}

/*
 * A store handle already bound to one principal, mirroring bindSession:
 * features receive this and cannot reach another user's records.
 */
export type UserOrderSubmissions = {
  createQuote(quote: NewQuote): Promise<{ id: string; quoteExpiresAt: Date }>;
  get(id: string): Promise<OrderSubmission | undefined>;
  issueConfirmation(id: string, request: ConfirmationRequest): Promise<boolean>;
  claim(
    id: string,
    check: { nonceHash: string; addressId: number; cartFingerprint: string },
  ): Promise<ClaimResult>;
  recordGateFailure(id: string, reason: GateFailure): Promise<boolean>;
  markOrderRequestStarted(id: string): Promise<boolean>;
  recoverUnsent(cartId: number): Promise<number>;
  recordOutcome(id: string, outcome: SubmissionOutcome): Promise<boolean>;
  recordPaid(id: string, evidence: OrderEvidence): Promise<boolean>;
  linkOrder(
    id: string,
    chowdeckOrderId: number,
    evidence: OrderEvidence,
  ): Promise<LinkResult>;
  listOpen(vendorId: number): Promise<OrderSubmission[]>;
};

export const bindOrderSubmissions = (
  store: OrderSubmissionStore,
  userId: string,
): UserOrderSubmissions => ({
  createQuote: (quote) => store.createQuote(userId, quote),
  get: (id) => store.get(userId, id),
  issueConfirmation: (id, request) =>
    store.issueConfirmation(userId, id, request),
  claim: (id, check) => store.claim(userId, id, check),
  recordGateFailure: (id, reason) =>
    store.recordGateFailure(userId, id, reason),
  markOrderRequestStarted: (id) => store.markOrderRequestStarted(userId, id),
  recoverUnsent: (cartId) => store.recoverUnsent(userId, cartId),
  recordOutcome: (id, outcome) => store.recordOutcome(userId, id, outcome),
  recordPaid: (id, evidence) => store.recordPaid(userId, id, evidence),
  linkOrder: (id, chowdeckOrderId, evidence) =>
    store.linkOrder(userId, id, chowdeckOrderId, evidence),
  listOpen: (vendorId) => store.listOpen(userId, vendorId),
});

export const QUOTE_LIFETIME_SECONDS = 5 * 60;

/*
 * A claimed submission whose order-request marker was never committed is
 * released (R1) only after this grace period, so a slow but live sender is
 * not interrupted. Safety does not depend on it: the marker and recovery
 * updates are mutually exclusive on the row.
 */
export const UNSENT_RECOVERY_GRACE_SECONDS = 2 * 60;
