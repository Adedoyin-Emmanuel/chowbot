import { sql } from "drizzle-orm";
import {
  text,
  uuid,
  boolean,
  check,
  index,
  bigint,
  integer,
  pgTable,
  timestamp,
  customType,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Uint8Array }>({
  dataType: () => "bytea",
});

/*
 * drizzle's jsonb() stringifies values itself, and Bun's driver then encodes
 * that string as a JSON string. Passing the array through lets Bun encode it
 * once, as a real JSON array.
 */
const jsonbArray = customType<{ data: string[]; driverData: string[] }>({
  dataType: () => "jsonb",
  toDriver: (value) => value,
});

/*
 * A JSON object passed through for Bun to encode once, as for jsonbArray.
 */
const jsonbObject = customType<{ data: Record<string, unknown>; driverData: Record<string, unknown> }>({
  dataType: () => "jsonb",
  toDriver: (value) => value,
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const expiresAt = () => timestamp("expires_at", { withTimezone: true }).notNull();
const stringArray = (name: string) => jsonbArray(name).notNull();
const isArray = (column: AnyPgColumn) => sql`jsonb_typeof(${column}) = 'array'`;

export const oauthClients = pgTable(
  "oauth_clients",
  {
    clientId: text("client_id").primaryKey(),
    clientName: text("client_name"),
    redirectUris: stringArray("redirect_uris"),
    grantTypes: stringArray("grant_types"),
    responseTypes: stringArray("response_types"),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method").notNull(),
    clientIdIssuedAt: bigint("client_id_issued_at", { mode: "number" }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "oauth_clients_redirect_uris_check",
      sql`${isArray(table.redirectUris)} AND jsonb_array_length(${table.redirectUris}) > 0`,
    ),
    check("oauth_clients_grant_types_check", isArray(table.grantTypes)),
    check("oauth_clients_response_types_check", isArray(table.responseTypes)),
  ],
);

/*
 * Users are keyed by an HMAC of the verified phone number; the table never
 * holds the number itself.
 */
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  phoneHash: text("phone_hash").notNull().unique(),
  createdAt: createdAt(),
});

export const chowdeckSessions = pgTable("chowdeck_sessions", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  encryptedSession: bytea("encrypted_session").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const oauthAuthorizationCodes = pgTable(
  "oauth_authorization_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    codeChallengeMethod: text("code_challenge_method", { enum: ["S256"] }).notNull(),
    resource: text("resource").notNull(),
    scopes: stringArray("scopes"),
    expiresAt: expiresAt(),
    createdAt: createdAt(),
  },
  (table) => [
    check(
      "oauth_authorization_codes_code_challenge_method_check",
      sql`${table.codeChallengeMethod} = 'S256'`,
    ),
    check("oauth_authorization_codes_scopes_check", isArray(table.scopes)),
    index("oauth_authorization_codes_expires_at_idx").on(table.expiresAt),
  ],
);

export const oauthAccessTokens = pgTable(
  "oauth_access_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    scopes: stringArray("scopes"),
    refreshFamilyId: uuid("refresh_family_id").references(() => oauthRefreshTokenFamilies.id, {
      onDelete: "cascade",
    }),
    expiresAt: expiresAt(),
    createdAt: createdAt(),
  },
  (table) => [
    check("oauth_access_tokens_scopes_check", isArray(table.scopes)),
    index("oauth_access_tokens_expires_at_idx").on(table.expiresAt),
    index("oauth_access_tokens_user_id_idx").on(table.userId),
    index("oauth_access_tokens_refresh_family_id_idx").on(table.refreshFamilyId),
  ],
);

/*
 * One family per browser sign-in. Its bindings never change across
 * rotations; expires_at is the absolute limit for every token in it, and
 * revoked_at is set when reuse of a rotated token is detected.
 */
export const oauthRefreshTokenFamilies = pgTable(
  "oauth_refresh_token_families",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id")
      .notNull()
      .references(() => oauthClients.clientId, { onDelete: "cascade" }),
    resource: text("resource").notNull(),
    scopes: stringArray("scopes"),
    expiresAt: expiresAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revokedReason: text("revoked_reason"),
    createdAt: createdAt(),
  },
  (table) => [
    check("oauth_refresh_token_families_scopes_check", isArray(table.scopes)),
    index("oauth_refresh_token_families_user_id_idx").on(table.userId),
    index("oauth_refresh_token_families_expires_at_idx").on(table.expiresAt),
  ],
);

/*
 * Every refresh token ever issued in a family, by hash only. Rotated tokens
 * are kept until the family expires so their reuse can be detected; the
 * partial unique index allows at most one unrotated token per family.
 */
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    familyId: uuid("family_id")
      .notNull()
      .references(() => oauthRefreshTokenFamilies.id, { onDelete: "cascade" }),
    expiresAt: expiresAt(),
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (table) => [
    index("oauth_refresh_tokens_family_id_idx").on(table.familyId),
    uniqueIndex("oauth_refresh_tokens_one_active_per_family_idx")
      .on(table.familyId)
      .where(sql`${table.rotatedAt} IS NULL`),
  ],
);

export const ORDER_SUBMISSION_STATES = [
  "quoted",
  "confirmation_pending",
  "submitting",
  "created",
  "unknown",
  "failed",
  "paid",
  "released",
] as const;

/*
 * States that hold a cart's submission lock. A paid order keeps it until a
 * later claim sees the cart has changed.
 */
export const LOCKING_SUBMISSION_STATES = ["submitting", "created", "unknown", "paid"] as const;

export const PAYMENT_START_STATES = ["started", "rejected", "unknown"] as const;

/*
 * Why a cart lock was released: by a later claim that found the paid
 * order's cart changed, or by an authenticated operator (with an audit row in
 * order_submission_recoveries). Neither changes the attempt's state.
 */
export const LOCK_RELEASE_REASONS = ["cart_changed", "operator_released"] as const;

const inList = (values: readonly string[]) =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));

/*
 * One row per orderable checkout quote and, later, its submission. fee_id is
 * internal and never returned; the address is stored only as an HMAC; the
 * confirmation nonce only as a hash. The partial unique index allows at most
 * one lock-holding submission per user and cart, across every server
 * instance.
 */
export const orderSubmissions = pgTable(
  "order_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    vendorId: integer("vendor_id").notNull(),
    cartId: bigint("cart_id", { mode: "number" }).notNull(),
    feeId: bigint("fee_id", { mode: "number" }).notNull(),
    addressBinding: text("address_binding").notNull(),
    cartFingerprint: text("cart_fingerprint").notNull(),
    computedTotal: bigint("computed_total", { mode: "number" }).notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true }).notNull(),
    paymentMethodId: bigint("payment_method_id", { mode: "number" }),
    paymentChannelName: text("payment_channel_name"),
    confirmationNonceHash: text("confirmation_nonce_hash"),
    confirmationExpiresAt: timestamp("confirmation_expires_at", { withTimezone: true }),
    confirmationConsumedAt: timestamp("confirmation_consumed_at", { withTimezone: true }),
    state: text("state", { enum: ORDER_SUBMISSION_STATES }).notNull(),
    failureReason: text("failure_reason", {
      enum: ["gate_rejected", "gate_uncertain", "order_rejected", "not_sent"],
    }),
    resolution: text("resolution", {
      enum: ["paid_verified", "linked_user_supplied_order"],
    }),
    orderRequestStartedAt: timestamp("order_request_started_at", { withTimezone: true }),
    evidenceOrderStatus: text("evidence_order_status"),
    evidencePaymentStatus: text("evidence_payment_status"),
    evidenceCheckedAt: timestamp("evidence_checked_at", { withTimezone: true }),
    chowdeckOrderId: bigint("chowdeck_order_id", { mode: "number" }),
    lockReleasedAt: timestamp("lock_released_at", { withTimezone: true }),
    lockReleaseReason: text("lock_release_reason", { enum: LOCK_RELEASE_REASONS }),
    paymentStartedAt: timestamp("payment_started_at", { withTimezone: true }),
    paymentStartState: text("payment_start_state", { enum: PAYMENT_START_STATES }),
    paidAfterReleaseAt: timestamp("paid_after_release_at", { withTimezone: true }),
    paidAfterReleaseOrderStatus: text("paid_after_release_order_status"),
    paidAfterReleasePaymentStatus: text("paid_after_release_payment_status"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (table) => [
    check("order_submissions_state_check", sql`${table.state} IN (${inList(ORDER_SUBMISSION_STATES)})`),
    check(
      "order_submissions_ids_check",
      sql`${table.vendorId} > 0 AND ${table.cartId} > 0 AND ${table.feeId} > 0`,
    ),
    check("order_submissions_computed_total_check", sql`${table.computedTotal} > 0`),
    check(
      "order_submissions_failure_reason_check",
      sql`(${table.state} = 'failed') = (${table.failureReason} IS NOT NULL) AND (${table.failureReason} IS NULL OR ${table.failureReason} IN ('gate_rejected', 'gate_uncertain', 'order_rejected', 'not_sent'))`,
    ),
    check(
      "order_submissions_resolution_check",
      sql`${table.resolution} IS NULL OR ${table.resolution} IN ('paid_verified', 'linked_user_supplied_order')`,
    ),
    check(
      "order_submissions_lock_release_check",
      sql`(${table.lockReleasedAt} IS NULL) = (${table.lockReleaseReason} IS NULL) AND (${table.lockReleaseReason} IS NULL OR ${table.lockReleaseReason} IN (${inList(LOCK_RELEASE_REASONS)}))`,
    ),
    check(
      "order_submissions_confirmation_pending_check",
      sql`${table.state} <> 'confirmation_pending' OR (${table.paymentMethodId} IS NOT NULL AND ${table.confirmationNonceHash} IS NOT NULL AND ${table.confirmationExpiresAt} IS NOT NULL)`,
    ),
    check(
      "order_submissions_confirmation_expiry_check",
      sql`${table.confirmationExpiresAt} IS NULL OR ${table.confirmationExpiresAt} <= ${table.quoteExpiresAt}`,
    ),
    check(
      "order_submissions_consumed_check",
      sql`${table.state} NOT IN (${inList(LOCKING_SUBMISSION_STATES)}) OR ${table.confirmationConsumedAt} IS NOT NULL`,
    ),
    check(
      "order_submissions_order_id_check",
      sql`${table.state} NOT IN ('created', 'paid') OR ${table.chowdeckOrderId} IS NOT NULL`,
    ),
    /*
     * The order-request marker: committed before an order request may be
     * sent. A row without it provably never had a request sent; rows that
     * report a request outcome must have it; gate and never-sent failures
     * must not.
     */
    check(
      "order_submissions_marker_check",
      sql`(${table.state} NOT IN ('quoted', 'confirmation_pending') OR ${table.orderRequestStartedAt} IS NULL)
        AND (${table.state} NOT IN ('created', 'unknown', 'paid') OR ${table.orderRequestStartedAt} IS NOT NULL)
        AND (${table.failureReason} IS NULL OR ${table.failureReason} NOT IN ('gate_rejected', 'gate_uncertain', 'not_sent') OR ${table.orderRequestStartedAt} IS NULL)
        AND (${table.failureReason} IS NULL OR ${table.failureReason} <> 'order_rejected' OR ${table.orderRequestStartedAt} IS NOT NULL)`,
    ),
    /*
     * The payment-start marker: payment_started_at is committed before the
     * one payment-start request is sent, only for a created order. A marker
     * without a state is a request whose outcome was never recorded.
     */
    check(
      "order_submissions_payment_start_check",
      sql`(${table.paymentStartedAt} IS NULL OR ${table.chowdeckOrderId} IS NOT NULL)
        AND (${table.paymentStartState} IS NULL OR ${table.paymentStartedAt} IS NOT NULL)
        AND (${table.paymentStartState} IS NULL OR ${table.paymentStartState} IN (${inList(PAYMENT_START_STATES)}))`,
    ),
    /*
     * Payment confirmed by Chowdeck after an operator released (abandoned) a
     * created order. It is recorded beside the attempt, never by changing its
     * state, resolution or lock.
     */
    check(
      "order_submissions_paid_after_release_check",
      sql`${table.paidAfterReleaseAt} IS NULL OR (${table.state} = 'created' AND ${table.chowdeckOrderId} IS NOT NULL AND ${table.lockReleaseReason} = 'operator_released')`,
    ),
    uniqueIndex("order_submissions_one_lock_per_cart_idx")
      .on(table.userId, table.cartId)
      .where(sql`${table.lockReleasedAt} IS NULL AND ${table.state} IN (${inList(LOCKING_SUBMISSION_STATES)})`),
    index("order_submissions_user_id_idx").on(table.userId),
    index("order_submissions_quote_expires_at_idx").on(table.quoteExpiresAt),
    uniqueIndex("order_submissions_chowdeck_order_id_idx")
      .on(table.chowdeckOrderId)
      .where(sql`${table.chowdeckOrderId} IS NOT NULL`),
  ],
);

/*
 * Operators who may release stuck order attempts from the recovery CLI. The
 * credential is stored only as a password hash (argon2id); the plaintext is
 * shown once when the operator is added.
 */
export const adminOperators = pgTable(
  "admin_operators",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    credentialHash: text("credential_hash").notNull(),
    createdAt: createdAt(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    bootstrap: boolean("bootstrap").notNull().default(false),
  },
  (table) => [
    check("admin_operators_name_check", sql`${table.name} ~ '^[a-z0-9][a-z0-9._-]{1,62}$'`),
    /*
     * At most one operator is ever created without authentication: the
     * first. The bootstrap insert also runs under a table lock that refuses
     * it once any operator exists.
     */
    uniqueIndex("admin_operators_one_bootstrap_idx").on(table.bootstrap).where(sql`${table.bootstrap}`),
  ],
);

export const RECOVERY_REASON_CODES = [
  "user_reported_no_order",
  "user_accepts_duplicate_risk",
  "order_not_retrievable",
  "user_reported_abandoned",
  "user_reported_cancelled_in_app",
] as const;

export const RECOVERY_LOOKUP_OUTCOMES = ["unpaid", "failed", "not_applicable"] as const;

/*
 * Append-only audit of operator lock releases (a trigger in the migration
 * rejects UPDATE, DELETE and TRUNCATE). One release per attempt. Each row
 * keeps a snapshot of the attempt as it was, the read-only Chowdeck lookup
 * made just before, who released it, why, and the exact risk disclosure the
 * operator acknowledged. User statements are stored only as reason codes
 * named user_reported_*, never as Chowdeck facts.
 */
export const orderSubmissionRecoveries = pgTable(
  "order_submission_recoveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => orderSubmissions.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    operatorId: uuid("operator_id")
      .notNull()
      .references(() => adminOperators.id, { onDelete: "restrict" }),
    reasonCode: text("reason_code", { enum: RECOVERY_REASON_CODES }).notNull(),
    note: text("note").notNull(),
    attemptSnapshot: jsonbObject("attempt_snapshot").notNull(),
    lookupOutcome: text("lookup_outcome", { enum: RECOVERY_LOOKUP_OUTCOMES }).notNull(),
    lookupOrderStatus: text("lookup_order_status"),
    lookupPaymentStatus: text("lookup_payment_status"),
    lookupError: text("lookup_error"),
    duplicateRiskAcknowledged: boolean("duplicate_risk_acknowledged").notNull(),
    disclosure: text("disclosure").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check("order_submission_recoveries_reason_check", sql`${table.reasonCode} IN (${inList(RECOVERY_REASON_CODES)})`),
    check(
      "order_submission_recoveries_lookup_check",
      sql`${table.lookupOutcome} IN (${inList(RECOVERY_LOOKUP_OUTCOMES)})
        AND (${table.lookupOutcome} = 'failed') = (${table.lookupError} IS NOT NULL)
        AND (${table.reasonCode} <> 'order_not_retrievable' OR ${table.lookupOutcome} = 'failed')`,
    ),
    check("order_submission_recoveries_note_check", sql`char_length(btrim(${table.note})) BETWEEN 10 AND 2000`),
    check("order_submission_recoveries_acknowledged_check", sql`${table.duplicateRiskAcknowledged} = true`),
    check("order_submission_recoveries_snapshot_check", sql`jsonb_typeof(${table.attemptSnapshot}) = 'object'`),
    check("order_submission_recoveries_disclosure_check", sql`char_length(${table.disclosure}) > 0`),
    uniqueIndex("order_submission_recoveries_one_per_attempt_idx").on(table.submissionId),
    index("order_submission_recoveries_user_id_idx").on(table.userId),
  ],
);
