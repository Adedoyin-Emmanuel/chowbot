import { sql } from "drizzle-orm";

import { users } from "./schema";
import type { UserStore } from "../users";
import type { Database } from "./database";
import type { Keyring } from "../encryption";

/*
 * Users are looked up by a keyed HMAC of the verified phone number, so the
 * table never holds phone numbers and the hashes cannot be reversed by
 * enumerating Nigerian numbers without the encryption key.
 */
export class PostgresUserStore implements UserStore {
  constructor(
    private readonly db: Database,
    private readonly keyring: Keyring,
  ) {}

  async findOrCreateByPhone(phone: string) {
    const [row] = await this.db
      .insert(users)
      .values({ phoneHash: this.keyring.hashPhone(phone) })
      .onConflictDoUpdate({ target: users.phoneHash, set: { phoneHash: sql`excluded.phone_hash` } })
      .returning({ id: users.id });
    return row!.id;
  }
}
