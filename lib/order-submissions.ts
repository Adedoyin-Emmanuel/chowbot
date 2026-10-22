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
  | "released"
  | "cancelled";

export type GateFailure = "gate_rejected" | "gate_uncertain";

/*
 * The recorded outcome of the one payment-start request for an order.
 * started: Chowdeck returned a payment link; rejected: Chowdeck definitely
 * refused; unknown: a payment may or may not have been started.
 */
export type PaymentStartState = "started" | "rejected" | "unknown";

/*
 * The recorded outcome of the one cancellation request for an order.
 * accepted: Chowdeck answered success, which alone does not prove the order
 * is cancelled (its order record decides); rejected: Chowdeck definitely
 * refused; unknown: the order may or may not have been cancelled.
 */
export type CancelRequestState = "accepted" | "rejected" | "unknown";

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
  paymentStartedAt: Date | null;
  paymentStartState: PaymentStartState | null;
  lockReleasedAt: Date | null;
  lockReleaseReason: "cart_changed" | "operator_released" | null;
  paidAfterReleaseAt: Date | null;
  /*
   * The promo code applied in the quote, with the discount Chowdeck's
   * calculation returned for it; both null when the quote has none.
   */
  promoCode: string | null;
  promoDiscount: number | null;
  cancelRequestedAt: Date | null;
  cancelRequestState: CancelRequestState | null;
};

/*
 * An attempt whose lock an operator released recently, with the recorded
 * recovery reason. Its state is still the attempt's real state.
 */
export type ReleasedSubmission = OrderSubmission & {
  recoveryReasonCode: string | null;
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
  promo?: { code: string; discount: number };
};

export type ConfirmationRequest = {
  nonceHash: string;
  ttlSeconds: number;
  /*
   * null for wallet and pay_for_me, which carry no channel id.
   */
  paymentMethodId: number | null;
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
  markPaymentStarted(
    userId: string,
    id: string,
    chowdeckOrderId: number,
  ): Promise<boolean>;
  recordPaymentStart(
    userId: string,
    id: string,
    state: PaymentStartState,
  ): Promise<boolean>;
  listRecentlyReleased(
    userId: string,
    vendorId: number,
  ): Promise<ReleasedSubmission[]>;
  recordPaidAfterRelease(
    userId: string,
    id: string,
    evidence: OrderEvidence,
  ): Promise<boolean>;
  supersedeQuotes(userId: string, cartId: number, keepId: string): Promise<number>;
  markCancelRequested(
    userId: string,
    id: string,
    chowdeckOrderId: number,
  ): Promise<boolean>;
  recordCancelRequest(
    userId: string,
    id: string,
    state: CancelRequestState,
  ): Promise<boolean>;
  recordCancelled(
    userId: string,
    id: string,
    evidence: OrderEvidence,
  ): Promise<boolean>;
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
  markPaymentStarted(id: string, chowdeckOrderId: number): Promise<boolean>;
  recordPaymentStart(id: string, state: PaymentStartState): Promise<boolean>;
  listRecentlyReleased(vendorId: number): Promise<ReleasedSubmission[]>;
  recordPaidAfterRelease(id: string, evidence: OrderEvidence): Promise<boolean>;
  supersedeQuotes(cartId: number, keepId: string): Promise<number>;
  markCancelRequested(id: string, chowdeckOrderId: number): Promise<boolean>;
  recordCancelRequest(id: string, state: CancelRequestState): Promise<boolean>;
  recordCancelled(id: string, evidence: OrderEvidence): Promise<boolean>;
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
  markPaymentStarted: (id, chowdeckOrderId) =>
    store.markPaymentStarted(userId, id, chowdeckOrderId),
  recordPaymentStart: (id, state) =>
    store.recordPaymentStart(userId, id, state),
  listRecentlyReleased: (vendorId) =>
    store.listRecentlyReleased(userId, vendorId),
  recordPaidAfterRelease: (id, evidence) =>
    store.recordPaidAfterRelease(userId, id, evidence),
  supersedeQuotes: (cartId, keepId) =>
    store.supersedeQuotes(userId, cartId, keepId),
  markCancelRequested: (id, chowdeckOrderId) =>
    store.markCancelRequested(userId, id, chowdeckOrderId),
  recordCancelRequest: (id, state) =>
    store.recordCancelRequest(userId, id, state),
  recordCancelled: (id, evidence) =>
    store.recordCancelled(userId, id, evidence),
});

export const QUOTE_LIFETIME_SECONDS = 5 * 60;

/*
 * Operator recovery: an attempt whose order request was sent with an unknown
 * outcome may be released only this long after the request started, and a
 * released attempt keeps triggering duplicate-order warnings for this long.
 */
export const UNKNOWN_RECOVERY_WAIT_HOURS = 24;
export const RELEASED_WARNING_DAYS = 7;

/*
 * A claimed submission whose order-request marker was never committed is
 * released (R1) only after this grace period, so a slow but live sender is
 * not interrupted. Safety does not depend on it: the marker and recovery
 * updates are mutually exclusive on the row.
 */
export const UNSENT_RECOVERY_GRACE_SECONDS = 2 * 60;
