import {
  RELEASED_WARNING_DAYS,
  UNKNOWN_RECOVERY_WAIT_HOURS,
  type OrderSubmissionStore,
} from "../../lib/order-submissions";
import {
  REASONS_FOR_CREATED,
  REASONS_FOR_UNRESOLVED,
  type Operator,
  type RecoveryStore,
  type RecoveryLookup,
  type ReleaseRefusal,
  type RecoverableAttempt,
  type RecoveryReasonCode,
} from "../../lib/recovery";
import { NotSignedInError } from "../addresses/service";
import { bindSession, type SessionStore } from "../../lib/session";
import { ChowdeckApiError, ChowdeckClient } from "../../lib/client";
import OrderService, { readPaymentEvidence } from "../orders/service";

export const NOTE_MIN_LENGTH = 10;
export const NOTE_MAX_LENGTH = 2000;

export type ReleaseInput = {
  note: string;
  attemptId: string;
  reasonCode: string;
  operator: Operator;
  acknowledgeDuplicateRisk: boolean;
};

export type RecoveryRefusal =
  | ReleaseRefusal
  | "acknowledgement_required"
  | "invalid_note"
  | "invalid_reason"
  | "reason_not_allowed"
  | "reason_requires_failed_lookup"
  | "paid";

export type RecoveryOutcome =
  | {
      released: true;
      releasedAt: Date;
      disclosure: string;
      recoveryId: string;
      lookup: RecoveryLookup;
    }
  | {
      detail: string;
      released: false;
      reason: RecoveryRefusal;
      lookup?: RecoveryLookup;
    };

const REFUSALS: Record<RecoveryRefusal, string> = {
  not_found: "no order attempt has that id",
  already_released: "this attempt was already marked abandoned",
  state_changed:
    "the attempt changed while it was being checked; run the command again",
  not_eligible:
    "only a created order, or an order request with an unknown outcome, can be marked abandoned",
  wait_not_elapsed: `an attempt with an unknown outcome can be marked abandoned only ${UNKNOWN_RECOVERY_WAIT_HOURS} hours after its order request started`,
  acknowledgement_required:
    "the duplicate-order risk must be acknowledged explicitly (--acknowledge-duplicate-risk)",
  invalid_note: `a note of ${NOTE_MIN_LENGTH} to ${NOTE_MAX_LENGTH} characters explaining why it is abandoned is required`,
  invalid_reason: "unknown reason code",
  reason_not_allowed: "that reason does not apply to an attempt in this state",
  reason_requires_failed_lookup:
    "order_not_retrievable requires the Chowdeck lookup to fail, but Chowdeck returned the order",
  paid: "Chowdeck shows this order paid; the payment was recorded and the attempt was not marked abandoned",
};

const ALL_REASONS = new Set<string>([
  ...REASONS_FOR_CREATED,
  ...REASONS_FOR_UNRESOLVED,
]);

const isUnresolved = (attempt: RecoverableAttempt) =>
  attempt.state === "unknown" ||
  (attempt.state === "submitting" && attempt.orderRequestStartedAt !== null);

export const reasonsFor = (attempt: RecoverableAttempt) =>
  attempt.state === "created"
    ? REASONS_FOR_CREATED
    : isUnresolved(attempt)
      ? REASONS_FOR_UNRESOLVED
      : [];

/*
 * Only the error's kind and status are kept: upstream messages are not
 * stored in the audit trail.
 */
const sanitizeLookupError = (error: unknown) => {
  if (error instanceof NotSignedInError) return "not_signed_in";
  if (error instanceof ChowdeckApiError)
    return error.status !== undefined
      ? `${error.kind} ${error.status}`
      : error.kind;
  return "unexpected";
};

/*
 * The exact risk the operator acknowledges; stored verbatim with the
 * release. It never says that an order was cancelled.
 */
export const disclosureFor = (attempt: RecoverableAttempt) =>
  [
    "Marking this attempt abandoned means ChowBot stops tracking it and releases its cart lock. Abandoned is not cancelled: it does not cancel, refund or change anything on Chowdeck, and ChowBot has not cancelled any order.",
    attempt.state === "created"
      ? `Chowdeck order ${attempt.chowdeckOrderId} may still exist and may still be payable.`
      : "An order may or may not exist on Chowdeck for this attempt; its outcome is unknown.",
    ...(attempt.paymentStartedAt
      ? [
          `A payment page was started for this order (payment start: ${attempt.paymentStartState ?? "outcome not recorded"}) and may still work; paying it would pay for the existing order.`,
        ]
      : []),
    "Once it is abandoned, a new order from the same cart may duplicate an existing order.",
    `ChowBot keeps warning about this attempt before new orders at this restaurant for ${RELEASED_WARNING_DAYS} days.`,
  ].join(" ");

/*
 * Releases a stuck attempt's cart lock for an authenticated operator. A
 * read-only Chowdeck lookup runs first for a created order: if Chowdeck shows
 * it paid, the payment is recorded through the normal path and nothing is
 * released; if the lookup fails, its error is recorded and the outcome stays
 * uncertain. The attempt's state, order id and evidence never change.
 */
class RecoveryService {
  constructor(
    private readonly recoveries: RecoveryStore,
    private readonly submissions: OrderSubmissionStore,
    private readonly sessions: SessionStore,
    private readonly client: ChowdeckClient,
  ) {}

  getAttempt(attemptId: string) {
    return this.recoveries.getAttempt(attemptId);
  }

  private refuse(
    reason: RecoveryRefusal,
    lookup?: RecoveryLookup,
  ): RecoveryOutcome {
    return {
      released: false,
      reason,
      detail: REFUSALS[reason],
      ...(lookup && { lookup }),
    };
  }

  private async lookup(attempt: RecoverableAttempt) {
    if (attempt.state !== "created" || !attempt.chowdeckOrderId)
      return {
        paid: false,
        lookup: { outcome: "not_applicable" } as RecoveryLookup,
      };
    const orders = new OrderService(
      bindSession(this.sessions, attempt.userId),
      this.client,
    );
    try {
      const { paid, evidence } = await readPaymentEvidence(
        orders,
        attempt.chowdeckOrderId,
      );
      return {
        paid,
        evidence,
        lookup: { outcome: "unpaid", ...evidence } as RecoveryLookup,
      };
    } catch (error) {
      return {
        paid: false,
        lookup: {
          outcome: "failed",
          error: sanitizeLookupError(error),
        } as RecoveryLookup,
      };
    }
  }

  async release(input: ReleaseInput): Promise<RecoveryOutcome> {
    if (input.acknowledgeDuplicateRisk !== true)
      return this.refuse("acknowledgement_required");
    const note = input.note.trim();
    if (note.length < NOTE_MIN_LENGTH || note.length > NOTE_MAX_LENGTH)
      return this.refuse("invalid_note");
    if (!ALL_REASONS.has(input.reasonCode))
      return this.refuse("invalid_reason");
    const reasonCode = input.reasonCode as RecoveryReasonCode;

    const attempt = await this.recoveries.getAttempt(input.attemptId);
    if (!attempt) return this.refuse("not_found");
    if (attempt.lockReleasedAt) return this.refuse("already_released");
    if (attempt.state !== "created" && !isUnresolved(attempt))
      return this.refuse("not_eligible");
    if (!reasonsFor(attempt).includes(reasonCode))
      return this.refuse("reason_not_allowed");
    if (attempt.state !== "created" && !attempt.waitElapsed)
      return this.refuse("wait_not_elapsed");

    const checked = await this.lookup(attempt);
    if (checked.paid && checked.evidence) {
      await this.submissions.recordPaid(
        attempt.userId,
        attempt.id,
        checked.evidence,
      );
      return this.refuse("paid", checked.lookup);
    }
    if (
      reasonCode === "order_not_retrievable" &&
      checked.lookup.outcome !== "failed"
    )
      return this.refuse("reason_requires_failed_lookup", checked.lookup);

    const disclosure = disclosureFor(attempt);
    const result = await this.recoveries.release({
      submissionId: attempt.id,
      expectedState: attempt.state,
      operatorId: input.operator.id,
      reasonCode,
      note,
      lookup: checked.lookup,
      disclosure,
      duplicateRiskAcknowledged: true,
    });
    if (!result.ok) return this.refuse(result.reason, checked.lookup);
    return {
      released: true,
      recoveryId: result.recoveryId,
      releasedAt: result.releasedAt,
      lookup: checked.lookup,
      disclosure,
    };
  }
}

export default RecoveryService;
