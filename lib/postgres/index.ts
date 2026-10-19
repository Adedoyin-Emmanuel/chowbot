import type { SQL } from "bun";

import type { Keyring } from "../encryption";
import { PostgresUserStore } from "./users";
import { PostgresClientStore } from "./clients";
import { PostgresSessionStore } from "./sessions";
import { PostgresAccessTokenStore } from "./access-tokens";
import { PostgresAuthorizationCodeStore } from "./authorization-codes";

export const createPostgresStores = (sql: SQL, keyring: Keyring) => ({
  users: new PostgresUserStore(sql, keyring),
  clients: new PostgresClientStore(sql),
  sessions: new PostgresSessionStore(sql, keyring),
  codes: new PostgresAuthorizationCodeStore(sql),
  tokens: new PostgresAccessTokenStore(sql),
});
