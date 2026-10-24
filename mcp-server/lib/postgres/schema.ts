import { sql } from "drizzle-orm";
import {
  text,
  uuid,
  check,
  index,
  bigint,
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
