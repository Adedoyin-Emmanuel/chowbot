import { timingSafeEqual } from "node:crypto";
import { and, desc, eq, getTableColumns, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";

import type { Database } from "./database";
import type { Keyring } from "../encryption";
import { LOCKING_SUBMISSION_STATES, orderSubmissionRecoveries, orderSubmissions } from "./schema";
import {
  QUOTE_LIFETIME_SECONDS,
  RELEASED_WARNING_DAYS,
  UNSENT_RECOVERY_GRACE_SECONDS,
  type NewQuote,
  type LinkResult,
  type OrderEvidence,
  type ClaimResult,
  type GateFailure,
  type OrderSubmission,
  type SubmissionOutcome,
  type PaymentStartState,
  type CancelRequestState,
  type ConfirmationRequest,
  type OrderSubmissionStore,
} from "../order-submissions";

const USER_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Row = typeof orderSubmissions.$inferSelect;

const toSubmission = (row: Row): OrderSubmission => ({
  id: row.id,
  vendorId: row.vendorId,
  cartId: row.cartId,
  cartFingerprint: row.cartFingerprint,
  computedTotal: row.computedTotal,
  state: row.state,
  quoteExpiresAt: row.quoteExpiresAt,
  paymentMethodId: row.paymentMethodId,
  paymentChannelName: row.paymentChannelName,
  chowdeckOrderId: row.chowdeckOrderId,
  claimedAt: row.confirmationConsumedAt,
  orderRequestStartedAt: row.orderRequestStartedAt,
  paymentStartedAt: row.paymentStartedAt,
  paymentStartState: row.paymentStartState,
  lockReleasedAt: row.lockReleasedAt,
  lockReleaseReason: row.lockReleaseReason,
  paidAfterReleaseAt: row.paidAfterReleaseAt,
  promoCode: row.promoCode,
  promoDiscount: row.promoDiscount,
  cancelRequestedAt: row.cancelRequestedAt,
  cancelRequestState: row.cancelRequestState,
  failureReason: row.failureReason,
  resolution: row.resolution,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const sameHash = (a: string | null, b: string) => {
  if (a === null) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const isUniqueViolation = (error: unknown) => {
  const cause = (error as { cause?: { errno?: unknown } } | undefined)?.cause;
  return cause?.errno === "23505";
};

const owned = (userId: string, id: string) =>
  and(eq(orderSubmissions.id, id), eq(orderSubmissions.userId, userId));

/*
 * Every expiry is compared with the database clock (now()), so server
 * instances with skewed clocks cannot disagree about a quote or a
 * confirmation. Records of a malformed user or record id simply do not exist.
 */
export class PostgresOrderSubmissionStore implements OrderSubmissionStore {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}

  private valid(userId: string, id: string) {
    return USER_ID_PATTERN.test(userId) && USER_ID_PATTERN.test(id);
  }

  async createQuote(userId: string, quote: NewQuote) {
    const [row] = await this.db
      .insert(orderSubmissions)
      .values({
        userId,
        vendorId: quote.vendorId,
        cartId: quote.cartId,
        feeId: quote.feeId,
        addressBinding: this.keyring.bindAddress(userId, quote.addressId),
        cartFingerprint: quote.cartFingerprint,
        computedTotal: quote.computedTotal,
        promoCode: quote.promo?.code ?? null,
        promoDiscount: quote.promo?.discount ?? null,
        quoteExpiresAt: sql`now() + make_interval(secs => ${QUOTE_LIFETIME_SECONDS})`,
        state: "quoted",
      })
      .returning({ id: orderSubmissions.id, quoteExpiresAt: orderSubmissions.quoteExpiresAt });
    return row!;
  }

  async get(userId: string, id: string) {
    if (!this.valid(userId, id)) return undefined;
    const [row] = await this.db.select().from(orderSubmissions).where(owned(userId, id));
    return row ? toSubmission(row) : undefined;
  }

  async issueConfirmation(userId: string, id: string, request: ConfirmationRequest) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({
        paymentMethodId: request.paymentMethodId,
        paymentChannelName: request.paymentChannelName,
        confirmationNonceHash: request.nonceHash,
        confirmationExpiresAt: sql`least(now() + make_interval(secs => ${request.ttlSeconds}), ${orderSubmissions.quoteExpiresAt})`,
        state: "confirmation_pending",
        updatedAt: sql`now()`,
      })
      .where(
        and(
          owned(userId, id),
          inArray(orderSubmissions.state, ["quoted", "confirmation_pending"]),
          isNull(orderSubmissions.confirmationConsumedAt),
          sql`${orderSubmissions.quoteExpiresAt} > now()`,
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * The atomic claim, committed before any order request is sent:
   *   1. lock the target row and check its state, expiry, nonce, address
   *      binding and cart fingerprint;
   *   2. lock any row already holding this cart's lock. A paid order on a
   *      cart that has since changed gives its lock up; any other holder
   *      refuses the claim;
   *   3. move the target to submitting and consume the nonce.
   * Two claims racing on different quotes for one cart cannot both commit:
   * the partial unique index rejects the second, which is reported as
   * cart_locked. Nothing here ever releases a submitting, created or unknown
   * lock.
   */
  async claim(
    userId: string,
    id: string,
    check: { nonceHash: string; addressId: number; cartFingerprint: string },
  ): Promise<ClaimResult> {
    if (!this.valid(userId, id)) return { ok: false, reason: "not_found" };
    try {
      return await this.db.transaction(async (tx): Promise<ClaimResult> => {
        const [target] = await tx
          .select({
            ...getTableColumns(orderSubmissions),
            quoteLive: sql<boolean>`${orderSubmissions.quoteExpiresAt} > now()`,
            confirmationLive: sql<boolean>`coalesce(${orderSubmissions.confirmationExpiresAt} > now(), false)`,
          })
          .from(orderSubmissions)
          .where(owned(userId, id))
          .for("update");

        if (!target) return { ok: false, reason: "not_found" };
        if (target.state !== "confirmation_pending") return { ok: false, reason: "not_confirmable" };
        if (target.confirmationConsumedAt !== null) return { ok: false, reason: "confirmation_invalid" };
        if (!target.quoteLive || !target.confirmationLive) return { ok: false, reason: "expired" };
        if (!sameHash(target.confirmationNonceHash, check.nonceHash)) {
          return { ok: false, reason: "confirmation_invalid" };
        }
        if (!sameHash(target.addressBinding, this.keyring.bindAddress(userId, check.addressId))) {
          return { ok: false, reason: "address_changed" };
        }
        if (target.cartFingerprint !== check.cartFingerprint) return { ok: false, reason: "cart_changed" };

        const holders = await tx
          .select({
            id: orderSubmissions.id,
            state: orderSubmissions.state,
            cartFingerprint: orderSubmissions.cartFingerprint,
          })
          .from(orderSubmissions)
          .where(
            and(
              eq(orderSubmissions.userId, userId),
              eq(orderSubmissions.cartId, target.cartId),
              ne(orderSubmissions.id, id),
              isNull(orderSubmissions.lockReleasedAt),
              inArray(orderSubmissions.state, [...LOCKING_SUBMISSION_STATES]),
            ),
          )
          .for("update");

        for (const holder of holders) {
          if (holder.state === "paid" && holder.cartFingerprint !== check.cartFingerprint) {
            await tx
              .update(orderSubmissions)
              .set({ lockReleasedAt: sql`now()`, lockReleaseReason: "cart_changed", updatedAt: sql`now()` })
              .where(eq(orderSubmissions.id, holder.id));
          } else {
            return { ok: false, reason: "cart_locked", lockedBy: holder.state };
          }
        }

        const [claimed] = await tx
          .update(orderSubmissions)
          .set({ state: "submitting", confirmationConsumedAt: sql`now()`, updatedAt: sql`now()` })
          .where(
            and(
              owned(userId, id),
              eq(orderSubmissions.state, "confirmation_pending"),
              isNull(orderSubmissions.confirmationConsumedAt),
            ),
          )
          .returning();
        if (!claimed) return { ok: false, reason: "not_confirmable" };
        return { ok: true, submission: toSubmission(claimed), feeId: claimed.feeId };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { ok: false, reason: "cart_locked" };
      throw error;
    }
  }

  /*
   * Only valid while the row is still submitting and no order request was
   * started: a row carrying the marker can never be released this way.
   */
  async recordGateFailure(userId: string, id: string, reason: GateFailure) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ state: "failed", failureReason: reason, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "submitting"),
          isNull(orderSubmissions.orderRequestStartedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * The order-request marker (R1). The caller may send the order request
   * only if this returns true, i.e. the update matched and committed. It
   * and recoverUnsent are conditional updates on the same row, so at most
   * one of them can ever succeed. A thrown error means the outcome is
   * unknown and the request must not be sent.
   */
  async markOrderRequestStarted(userId: string, id: string) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ orderRequestStartedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "submitting"),
          isNull(orderSubmissions.orderRequestStartedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * R1: releases this user's claimed submissions on this cart whose order
   * request provably never started (no marker), once the grace period has
   * passed since the claim. Never touches a row carrying the marker.
   */
  async recoverUnsent(userId: string, cartId: number) {
    if (!USER_ID_PATTERN.test(userId)) return 0;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ state: "failed", failureReason: "not_sent", updatedAt: sql`now()` })
      .where(
        and(
          eq(orderSubmissions.userId, userId),
          eq(orderSubmissions.cartId, cartId),
          eq(orderSubmissions.state, "submitting"),
          isNull(orderSubmissions.orderRequestStartedAt),
          sql`${orderSubmissions.confirmationConsumedAt} <= now() - make_interval(secs => ${UNSENT_RECOVERY_GRACE_SECONDS})`,
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length;
  }

  async recordOutcome(userId: string, id: string, outcome: SubmissionOutcome) {
    if (!this.valid(userId, id)) return false;
    const set =
      outcome.kind === "created"
        ? { state: "created" as const, chowdeckOrderId: outcome.chowdeckOrderId }
        : outcome.kind === "rejected"
          ? { state: "failed" as const, failureReason: "order_rejected" as const }
          : { state: "unknown" as const };
    const rows = await this.db
      .update(orderSubmissions)
      .set({ ...set, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "submitting"),
          isNotNull(orderSubmissions.orderRequestStartedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * Records verified payment. The cart lock is kept: it is released only by
   * a later claim that finds the cart changed. An attempt an operator has
   * already released is never changed here (see recordPaidAfterRelease).
   */
  async recordPaid(userId: string, id: string, evidence: OrderEvidence) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({
        state: "paid",
        resolution: "paid_verified",
        resolvedAt: sql`now()`,
        updatedAt: sql`now()`,
        evidenceOrderStatus: evidence.orderStatus,
        evidencePaymentStatus: evidence.paymentStatus,
        evidenceCheckedAt: sql`now()`,
      })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "created"),
          isNull(orderSubmissions.lockReleasedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * Records payment Chowdeck confirmed for a created order after an operator
   * released (abandoned) it. Only the paid_after_release columns and
   * updated_at change: the state, order id, resolution, lock release and the
   * recovery audit record stay as they were, and the lock is not retaken.
   * Recorded once; later reads leave the first record in place.
   */
  async recordPaidAfterRelease(userId: string, id: string, evidence: OrderEvidence) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({
        paidAfterReleaseAt: sql`now()`,
        paidAfterReleaseOrderStatus: evidence.orderStatus,
        paidAfterReleasePaymentStatus: evidence.paymentStatus,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "created"),
          isNotNull(orderSubmissions.chowdeckOrderId),
          eq(orderSubmissions.lockReleaseReason, "operator_released"),
          isNull(orderSubmissions.paidAfterReleaseAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * R3: links an order the user found in Chowdeck to an attempt whose
   * request was sent but whose outcome is unknown. The caller has already
   * verified the order through Chowdeck; the lock is kept (created). One
   * Chowdeck order can be linked to only one attempt.
   */
  async linkOrder(userId: string, id: string, chowdeckOrderId: number, evidence: OrderEvidence): Promise<LinkResult> {
    if (!this.valid(userId, id)) return "not_linkable";
    try {
      const rows = await this.db
        .update(orderSubmissions)
        .set({
          state: "created",
          chowdeckOrderId,
          resolution: "linked_user_supplied_order",
          resolvedAt: sql`now()`,
          updatedAt: sql`now()`,
          evidenceOrderStatus: evidence.orderStatus,
          evidencePaymentStatus: evidence.paymentStatus,
          evidenceCheckedAt: sql`now()`,
        })
        .where(
          and(
            owned(userId, id),
            inArray(orderSubmissions.state, ["unknown", "submitting"]),
            isNotNull(orderSubmissions.orderRequestStartedAt),
            isNull(orderSubmissions.chowdeckOrderId),
          ),
        )
        .returning({ id: orderSubmissions.id });
      return rows.length === 1 ? "linked" : "not_linkable";
    } catch (error) {
      if (isUniqueViolation(error)) return "order_already_linked";
      throw error;
    }
  }

  /*
   * This user's attempts at a restaurant that still hold a cart lock
   * (submitting, unknown, created or paid), newest first.
   */
  async listOpen(userId: string, vendorId: number) {
    if (!USER_ID_PATTERN.test(userId)) return [];
    const rows = await this.db
      .select()
      .from(orderSubmissions)
      .where(
        and(
          eq(orderSubmissions.userId, userId),
          eq(orderSubmissions.vendorId, vendorId),
          isNull(orderSubmissions.lockReleasedAt),
          inArray(orderSubmissions.state, [...LOCKING_SUBMISSION_STATES]),
        ),
      )
      .orderBy(desc(orderSubmissions.createdAt));
    return rows.map(toSubmission);
  }

  /*
   * This user's attempts at a restaurant whose lock an operator released in
   * the last RELEASED_WARNING_DAYS, newest first, with the recovery reason.
   */
  async listRecentlyReleased(userId: string, vendorId: number) {
    if (!USER_ID_PATTERN.test(userId)) return [];
    const rows = await this.db
      .select({ row: orderSubmissions, recoveryReasonCode: orderSubmissionRecoveries.reasonCode })
      .from(orderSubmissions)
      .leftJoin(orderSubmissionRecoveries, eq(orderSubmissionRecoveries.submissionId, orderSubmissions.id))
      .where(
        and(
          eq(orderSubmissions.userId, userId),
          eq(orderSubmissions.vendorId, vendorId),
          eq(orderSubmissions.lockReleaseReason, "operator_released"),
          sql`${orderSubmissions.lockReleasedAt} > now() - make_interval(days => ${RELEASED_WARNING_DAYS})`,
        ),
      )
      .orderBy(desc(orderSubmissions.lockReleasedAt));
    return rows.map(({ row, recoveryReasonCode }) => ({
      ...toSubmission(row),
      recoveryReasonCode,
    }));
  }

  /*
   * The payment-start marker, committed before the payment-start request is
   * sent. Only one can ever be set per attempt, and only on an unpaid created
   * order with the given id, so at most one payment start is ever sent for
   * an attempt, across every server instance.
   */
  async markPaymentStarted(userId: string, id: string, chowdeckOrderId: number) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ paymentStartedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "created"),
          eq(orderSubmissions.chowdeckOrderId, chowdeckOrderId),
          isNull(orderSubmissions.paymentStartedAt),
          isNull(orderSubmissions.lockReleasedAt),
          isNull(orderSubmissions.cancelRequestedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * Records the payment-start outcome once. The marker is never cleared, so
   * a rejected or unknown start is not retried.
   */
  async recordPaymentStart(userId: string, id: string, state: PaymentStartState) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ paymentStartState: state, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          isNotNull(orderSubmissions.paymentStartedAt),
          isNull(orderSubmissions.paymentStartState),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * A newer orderable quote replaces every older one for the same cart that
   * has not been claimed yet, so a stale total (for example one without a
   * promo code's discount) can no longer be confirmed. Claimed attempts are
   * never touched.
   */
  async supersedeQuotes(userId: string, cartId: number, keepId: string) {
    if (!this.valid(userId, keepId)) return 0;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ state: "failed", failureReason: "superseded", updatedAt: sql`now()` })
      .where(
        and(
          eq(orderSubmissions.userId, userId),
          eq(orderSubmissions.cartId, cartId),
          ne(orderSubmissions.id, keepId),
          inArray(orderSubmissions.state, ["quoted", "confirmation_pending"]),
          isNull(orderSubmissions.confirmationConsumedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length;
  }

  /*
   * The cancellation marker, committed before the one cancellation request
   * is sent: only on a created order with the given id that ChowBot still
   * tracks, and only once. Once set, no payment can be started for the
   * attempt.
   */
  async markCancelRequested(userId: string, id: string, chowdeckOrderId: number) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ cancelRequestedAt: sql`now()`, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "created"),
          eq(orderSubmissions.chowdeckOrderId, chowdeckOrderId),
          isNull(orderSubmissions.cancelRequestedAt),
          isNull(orderSubmissions.lockReleasedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * Records the cancellation request's outcome once. The marker is never
   * cleared, so a rejected or unknown cancellation is not retried.
   */
  async recordCancelRequest(userId: string, id: string, state: CancelRequestState) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({ cancelRequestState: state, updatedAt: sql`now()` })
      .where(
        and(
          owned(userId, id),
          isNotNull(orderSubmissions.cancelRequestedAt),
          isNull(orderSubmissions.cancelRequestState),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }

  /*
   * Records a cancellation Chowdeck's order record shows, whether ChowBot or
   * the user (in the app) cancelled it. Leaving the locking states frees the
   * cart lock. A paid or operator-released attempt is never changed here.
   */
  async recordCancelled(userId: string, id: string, evidence: OrderEvidence) {
    if (!this.valid(userId, id)) return false;
    const rows = await this.db
      .update(orderSubmissions)
      .set({
        state: "cancelled",
        resolution: "cancelled_verified",
        resolvedAt: sql`now()`,
        updatedAt: sql`now()`,
        evidenceOrderStatus: evidence.orderStatus,
        evidencePaymentStatus: evidence.paymentStatus,
        evidenceCheckedAt: sql`now()`,
      })
      .where(
        and(
          owned(userId, id),
          eq(orderSubmissions.state, "created"),
          isNotNull(orderSubmissions.chowdeckOrderId),
          isNull(orderSubmissions.lockReleasedAt),
        ),
      )
      .returning({ id: orderSubmissions.id });
    return rows.length === 1;
  }
}
