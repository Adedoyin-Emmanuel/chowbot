import type { SQL } from "bun";

import { createDrizzle } from "./database";
import type { Keyring } from "../encryption";
import { PostgresUserStore } from "./users";
import { PostgresClientStore } from "./clients";
import { PostgresSessionStore } from "./sessions";
import { PostgresCodeExchange } from "./token-exchange";
import { PostgresAccessTokenStore } from "./access-tokens";
import { PostgresAuthorizationCodeStore } from "./authorization-codes";

export const createPostgresStores = (sql: SQL, keyring: Keyring) => {
  const db = createDrizzle(sql);
  return {
    users: new PostgresUserStore(db, keyring),
    clients: new PostgresClientStore(db),
    sessions: new PostgresSessionStore(db, keyring),
    codes: new PostgresAuthorizationCodeStore(db),
    tokens: new PostgresAccessTokenStore(db),
    exchange: new PostgresCodeExchange(db),
  };
};
