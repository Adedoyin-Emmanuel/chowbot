import type { SQL } from "bun";

import type { UserStore } from "../users";
import type { Keyring } from "../encryption";

/*
 * Users are looked up by a keyed HMAC of the verified phone number, so the
 * table never holds phone numbers and the hashes cannot be reversed by
 * enumerating Nigerian numbers without the encryption key.
 */
export class PostgresUserStore implements UserStore {
  constructor(
    private readonly sql: SQL,
    private readonly keyring: Keyring,
  ) {}

  async findOrCreateByPhone(phone: string) {
    const [row] = await this.sql`
      INSERT INTO users (id, phone_hash)
      VALUES (${crypto.randomUUID()}, ${this.keyring.hashPhone(phone)})
      ON CONFLICT (phone_hash) DO UPDATE SET phone_hash = EXCLUDED.phone_hash
      RETURNING id
    `;
    return row.id as string;
  }
}
