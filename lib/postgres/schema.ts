import { sql } from "drizzle-orm";
import {
  text,
  uuid,
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
    lockReleaseReason: text("lock_release_reason", { enum: ["cart_changed"] }),
    paymentStartedAt: timestamp("payment_started_at", { withTimezone: true }),
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
      sql`(${table.lockReleasedAt} IS NULL) = (${table.lockReleaseReason} IS NULL) AND (${table.lockReleaseReason} IS NULL OR ${table.lockReleaseReason} IN ('cart_changed'))`,
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
