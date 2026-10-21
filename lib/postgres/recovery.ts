import { and, eq, getTableColumns, isNull, sql } from "drizzle-orm";

import type { Database } from "./database";
import type { OrderSubmission } from "../order-submissions";
import { UNKNOWN_RECOVERY_WAIT_HOURS } from "../order-submissions";
import { adminOperators, orderSubmissionRecoveries, orderSubmissions } from "./schema";
import type {
  OperatorStore,
  RecoveryStore,
  ReleaseRequest,
  ReleaseResult,
  RecoverableAttempt,
} from "../recovery";

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/*
 * Everything but the internal fee id, address binding and nonce hash.
 */
const {
  feeId: _feeId,
  addressBinding: _addressBinding,
  confirmationNonceHash: _nonceHash,
  ...attemptColumns
} = getTableColumns(orderSubmissions);

const waitElapsed = sql<boolean>`coalesce(${orderSubmissions.orderRequestStartedAt} <= now() - make_interval(hours => ${UNKNOWN_RECOVERY_WAIT_HOURS}), false)`;

const toAttempt = (row: Record<string, unknown>): RecoverableAttempt => ({
  id: row.id as string,
  userId: row.userId as string,
  vendorId: row.vendorId as number,
  cartId: row.cartId as number,
  cartFingerprint: row.cartFingerprint as string,
  computedTotal: row.computedTotal as number,
  state: row.state as OrderSubmission["state"],
  quoteExpiresAt: row.quoteExpiresAt as Date,
  paymentMethodId: row.paymentMethodId as number | null,
  paymentChannelName: row.paymentChannelName as string | null,
  chowdeckOrderId: row.chowdeckOrderId as number | null,
  claimedAt: row.confirmationConsumedAt as Date | null,
  orderRequestStartedAt: row.orderRequestStartedAt as Date | null,
  failureReason: row.failureReason as string | null,
  resolution: row.resolution as string | null,
  paymentStartedAt: row.paymentStartedAt as Date | null,
  paymentStartState: row.paymentStartState as OrderSubmission["paymentStartState"],
  lockReleasedAt: row.lockReleasedAt as Date | null,
  lockReleaseReason: row.lockReleaseReason as OrderSubmission["lockReleaseReason"],
  paidAfterReleaseAt: row.paidAfterReleaseAt as Date | null,
  createdAt: row.createdAt as Date,
  updatedAt: row.updatedAt as Date,
  waitElapsed: row.waitElapsed === true,
});

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : value ?? null);

/*
 * The audit snapshot: the attempt exactly as it was when the lock was taken,
 * with dates as ISO strings and no internal secrets.
 */
const snapshotOf = (row: Record<string, unknown>) => ({
  id: row.id,
  user_id: row.userId,
  vendor_id: row.vendorId,
  cart_id: row.cartId,
  cart_fingerprint: row.cartFingerprint,
  computed_total: row.computedTotal,
  state: row.state,
  failure_reason: row.failureReason ?? null,
  resolution: row.resolution ?? null,
  chowdeck_order_id: row.chowdeckOrderId ?? null,
  payment_method_id: row.paymentMethodId ?? null,
  payment_channel_name: row.paymentChannelName ?? null,
  evidence_order_status: row.evidenceOrderStatus ?? null,
  evidence_payment_status: row.evidencePaymentStatus ?? null,
  evidence_checked_at: iso(row.evidenceCheckedAt),
  payment_started_at: iso(row.paymentStartedAt),
  payment_start_state: row.paymentStartState ?? null,
  quote_expires_at: iso(row.quoteExpiresAt),
  confirmation_consumed_at: iso(row.confirmationConsumedAt),
  order_request_started_at: iso(row.orderRequestStartedAt),
  resolved_at: iso(row.resolvedAt),
  created_at: iso(row.createdAt),
  updated_at: iso(row.updatedAt),
});

const isUnresolved = (row: { state: unknown; orderRequestStartedAt: unknown }) =>
  row.state === "unknown" || (row.state === "submitting" && row.orderRequestStartedAt != null);

export class PostgresRecoveryStore implements RecoveryStore {
  constructor(private readonly db: Database) {}

  async getAttempt(id: string) {
    if (!ID_PATTERN.test(id)) return undefined;
    const [row] = await this.db
      .select({ ...attemptColumns, waitElapsed })
      .from(orderSubmissions)
      .where(eq(orderSubmissions.id, id));
    return row && toAttempt(row);
  }

  /*
   * Releases the lock and appends the audit row in one transaction, under a
   * row lock, so concurrent releases serialize: exactly one succeeds and the
   * rest see already_released. The attempt must still hold its lock, be in
   * the state the operator's lookup saw, and be eligible: created, or an
   * order request with an unknown outcome at least 24 hours old by the
   * database clock. Only lock_released_at, lock_release_reason and
   * updated_at change. If the audit insert fails, nothing is released.
   */
  async release(request: ReleaseRequest): Promise<ReleaseResult> {
    if (!ID_PATTERN.test(request.submissionId)) return { ok: false, reason: "not_found" };
    return this.db.transaction(async (tx): Promise<ReleaseResult> => {
      const [row] = await tx
        .select({ ...getTableColumns(orderSubmissions), waitElapsed })
        .from(orderSubmissions)
        .where(eq(orderSubmissions.id, request.submissionId))
        .for("update");
      if (!row) return { ok: false, reason: "not_found" };
      if (row.lockReleasedAt) return { ok: false, reason: "already_released" };
      if (row.state !== request.expectedState) return { ok: false, reason: "state_changed" };
      if (row.state !== "created" && !isUnresolved(row)) return { ok: false, reason: "not_eligible" };
      if (row.state !== "created" && !row.waitElapsed) return { ok: false, reason: "wait_not_elapsed" };

      const [released] = await tx
        .update(orderSubmissions)
        .set({
          lockReleasedAt: sql`now()`,
          lockReleaseReason: "operator_released",
          updatedAt: sql`now()`,
        })
        .where(and(eq(orderSubmissions.id, row.id), isNull(orderSubmissions.lockReleasedAt)))
        .returning({ releasedAt: orderSubmissions.lockReleasedAt });
      if (!released) return { ok: false, reason: "already_released" };

      const { lookup } = request;
      const [recovery] = await tx
        .insert(orderSubmissionRecoveries)
        .values({
          submissionId: row.id,
          userId: row.userId,
          operatorId: request.operatorId,
          reasonCode: request.reasonCode,
          note: request.note,
          attemptSnapshot: snapshotOf(row),
          lookupOutcome: lookup.outcome,
          lookupOrderStatus: lookup.outcome === "unpaid" ? lookup.orderStatus : null,
          lookupPaymentStatus: lookup.outcome === "unpaid" ? lookup.paymentStatus : null,
          lookupError: lookup.outcome === "failed" ? lookup.error : null,
          duplicateRiskAcknowledged: request.duplicateRiskAcknowledged,
          disclosure: request.disclosure,
        })
        .returning({ id: orderSubmissionRecoveries.id });
      return { ok: true, recoveryId: recovery!.id, releasedAt: released.releasedAt! };
    });
  }
}

export class PostgresOperatorStore implements OperatorStore {
  constructor(private readonly db: Database) {}

  async add(name: string, credentialHash: string) {
    const [row] = await this.db
      .insert(adminOperators)
      .values({ name, credentialHash })
      .returning({ id: adminOperators.id, name: adminOperators.name });
    return row!;
  }

  async find(name: string) {
    const [row] = await this.db.select().from(adminOperators).where(eq(adminOperators.name, name));
    return row && { id: row.id, name: row.name, credentialHash: row.credentialHash, disabledAt: row.disabledAt };
  }

  async disable(name: string) {
    const rows = await this.db
      .update(adminOperators)
      .set({ disabledAt: sql`now()` })
      .where(and(eq(adminOperators.name, name), isNull(adminOperators.disabledAt)))
      .returning({ id: adminOperators.id });
    return rows.length === 1;
  }

  /*
   * The table lock (SHARE ROW EXCLUSIVE conflicts with itself and with every
   * insert) serializes concurrent bootstraps across connections: the first
   * inserts, and the rest then see an operator and get undefined. The unique
   * index on bootstrap = true backs this up: a second bootstrap row can never
   * exist.
   */
  async bootstrap(name: string, credentialHash: string) {
    try {
      return await this.db.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE ${adminOperators} IN SHARE ROW EXCLUSIVE MODE`);
        const [existing] = await tx.select({ id: adminOperators.id }).from(adminOperators).limit(1);
        if (existing) return undefined;
        const [row] = await tx
          .insert(adminOperators)
          .values({ name, credentialHash, bootstrap: true })
          .returning({ id: adminOperators.id, name: adminOperators.name });
        return row;
      });
    } catch (error) {
      const cause = (error as { cause?: { errno?: unknown } } | undefined)?.cause;
      if (cause?.errno === "23505") return undefined;
      throw error;
    }
  }
}
